
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

class Sendjson {

    constructor () {

        //create array to store scams to help limit duplicates (when spammed)  
        this.tgScams = []

        //fetch keywords
        this.keywords = require("../keywords.json")

    }

    async send ({client, roomId, event, mxid, reactionQueue}, logchannel, banlistReader, reactions, responses){ 

        //if the message is replying
        let replyRelation = event["content"]["m.relates_to"]//["m.in_reply_to"]["event_id"]
        if (replyRelation){
    
            //pull the id of the event its replying to
            if (replyRelation["m.in_reply_to"]) { 
                let replyID = replyRelation["m.in_reply_to"]["event_id"]

                //fetch the event from that id
                let repliedEvent = await client.getEvent(roomId, replyID)
        
                //make the content scanable
                let scannableContent = repliedEvent["content"]["body"].toLowerCase()
        
                //if the message is replying to a scam, it doesnt need to be logged
                if (includesWord(scannableContent, [this.keywords.scams.currencies, this.keywords.scams.socials, this.keywords.scams.verbs])) {
                    return
                }

            }
    
        }

        //fetch the set alias of the room
        let mainRoomAlias = await client.getPublishedAlias(roomId)

        //if there is no alias of the room
        if(!mainRoomAlias){

            //dig through the state, find room name, and use that in place of the main room alias
            mainRoomAlias = (await client.getRoomState(roomId)).find(state => state.type == "m.room.name")["content"]["name"]

            //should still be able to go to the link using the https://matrix.to/#/ link
        }

        //check if already on banlist
        let entry = await banlistReader.match(logchannel, (event["sender"]))

        if (entry) {

            //get the reason its already on the banlist
            let existingReason = entry["content"]["reason"]

            //if the ban reason already includes that scam was sent in this room, theres nothing to add
            if (existingReason.includes(mainRoomAlias)) { return }

            //make banlist rule
            client.sendStateEvent(logchannel, "m.policy.rule.user", ("rule:" + event["sender"]), {
                "entity": event["sender"],
                "reason": (existingReason + " " + mainRoomAlias),
                "recommendation": "org.matrix.mjolnir.ban"
            })

            //dont send a log if its already been reported
            return

        }
    
        //limit duplicates
        if (this.tgScams.some(scam => (scam.event["content"]["body"] == event["content"]["body"]) && (scam.roomId == roomId) && (scam.event["sender"] == event["sender"]))) { return } else {
    
            this.tgScams.push({event:event, roomId:roomId})
    
        }
    
        //filename
        let filename = event["sender"] + "_" + roomId + "_@_" + (new Date()).toISOString() + ".json"

        //convert json into binary buffer
        let file = Buffer.from(JSON.stringify(event, null, 2))

        //upload the file buffer to the matrix homeserver, and grab mxc:// url
        let linktofile = await client.uploadContent(file, "application/json", filename)        

        //if the bot is in the room, that mean it's homeserver can be used for a via
        let via = mxid.split(":")[1]

        //escape html and '@' to avoid mentions
        let escapedText = event["content"]["body"].replaceAll("<","&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("@", "&64;")
        
        //send log message
        let logmsgid = await client.sendHtmlText(logchannel,(event["sender"] +  " in "+ mainRoomAlias + "\n<blockquote>" + escapedText
        + "</blockquote>\nhttps://matrix.to/#/" + roomId + "/" + event["event_id"] + "?via=" + via))
    
        //send the file that was uploaded
        let logfileid = await client.sendMessage(logchannel, {
            "body":filename,
            "info": {
                "mimetype": "application/json",
                "size":file.byteLength
            },
            "msgtype":"m.file",
            "url":linktofile,
        })    

        //easy reaction for moderators
        let checkMessagePromise = client.sendEvent(logchannel, "m.reaction", ({
            "m.relates_to": {
                "event_id":logmsgid,
                "key":"✅ confirm",
                "rel_type": "m.annotation"
            }
        }))

        //easy reaction for moderators
        let xMessagePromise = client.sendEvent(logchannel, "m.reaction", ({
            "m.relates_to": {
                "event_id":logmsgid,
                "key":"❌ falsepos",
                "rel_type": "m.annotation"
            }
        }))

        //add callback to the map to be called upon reaction event
        reactionQueue.set(logmsgid, async (event) => {

            let senderpl = (await client.getRoomStateEvent(logchannel, "m.room.power_levels", null))["users"][event["sender"]]

            if((senderpl === undefined) || (senderpl < 10 )) {return}

            let userReactionId = event["event_id"]

            if(event["content"]["m.relates_to"]["key"].includes("✅")){

                //only allow to run once
                reactionQueue.delete(logmsgid)

                //generate reason
                let reason = "telegram scam in " + mainRoomAlias //+ " (see " + await client.getPublishedAlias(logchannel) + " )"

                //make banlist rule
                client.sendStateEvent(logchannel, "m.policy.rule.user", ("rule:" + event["sender"]), {
                    "entity": event["sender"],
                    "reason": reason,
                    "recommendation": "org.matrix.mjolnir.ban"
                },)

                    .then(async () => {

                        //delete reactions to limit duplicate responses
                        //didnt await these earler for speed and performance, so need to await the promises now
                        client.redactEvent(logchannel, await checkMessagePromise, "related reaction").catch(() => {})
                        client.redactEvent(logchannel,  await xMessagePromise, "related reaction").catch(() => {})
                    
                        //confirm ban for clients that cant read banlist events
                        client.sendEvent(logchannel, "m.reaction", ({
                            "m.relates_to": {
                                "event_id":logmsgid,
                                "key":"🔨 | banned",
                                "rel_type": "m.annotation"
                            }
                        }))
                            //catch it in case edge case of duplicate actions, this way it wont error
                            .catch(() => {})

                        //attempt to redact the scam
                        client.redactEvent(roomId, event["event_id"], "confirmed scam").catch(() => {})
                    
                    })

                    //delete mod response even if it fails to enable trying again
                    .finally(async () => { client.redactEvent(logchannel, userReactionId, "related reaction").catch(() => {}) })
                    
                    //catch errors with sending the state event
                    .catch(err => client.sendHtmlNotice(logchannel, "<p>🍃 | I unfortunately ran into the following error while trying to add that to the banlist:\n</p><code>" + err+ "</code>"))

            } else if (event["content"]["m.relates_to"]["key"].includes("❌")){

                //only allow to run once
                reactionQueue.delete(logmsgid)

                //delete events already existing
                client.redactEvent(logchannel, logmsgid, "not a scam")
                client.redactEvent(logchannel, logfileid, "not a scam")
                client.redactEvent(logchannel, userReactionId, "related reaction")
                
                //didnt await these earler for speed and performance, so need to await the promises now
                client.redactEvent(logchannel, await checkMessagePromise, "related reaction")
                client.redactEvent(logchannel,  await xMessagePromise, "related reaction")

                //fetch the bots response to the scam
                let response = responses.get(event["event_id"])
                let reaction = reactions.get(event["event_id"])

                //if there is a response to the redacted message then redact the response
                try{
                    if (response) {await client.redactEvent(response.roomId, response.responseID, "False positive.")}
                    if (reaction) {await client.redactEvent(reaction.roomId, reaction.responseID, "False positive.")}

                //on the rare occasion that the room disables self redactions, or other error, this for some reason crashes the entire process
                //fuck you nodejs v20
                } catch (e) {

                    // error to send
                    let en = "🍃 | Error redacting warning."

                    //send to both log room and that room which it is supposed to redact
                    client.sendHtmlNotice(response.roomId, en)
                        .catch(() => {})
                        .finally(() => {client.sendHtmlNotice(logchannel, en)})

                }

            }

        })
        
    }

}

//function to scan if it matches the keywords
function includesWord (str, catgs) {

    //assume true if you dont have any missing
    let result = true

    catgs.forEach(cat => {

        if(!cat.some(word => str.includes(word))) result = false
        
    });

    return result

}

export { Sendjson };
