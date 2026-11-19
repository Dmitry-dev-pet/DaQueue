import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir=fileURLToPath(new URL("../",import.meta.url));
const source=fs.readFileSync(dir+"alfred-native.js","utf8");
const mf=JSON.parse(fs.readFileSync(dir+"manifest.json","utf8"));
const background=fs.readFileSync(dir+"background.js","utf8");
const sample=(title,channel,videoId)=>({videoRenderer:{
 videoId,title:{runs:[{text:title}]},ownerText:{runs:[{text:channel}]} }});
const searchPage=(...items)=>{
 const data={contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{
  contents:[{itemSectionRenderer:{contents:items}}]
 }}}}};
 return "<html><script>var ytInitialData = "+JSON.stringify(data)+";</script></html>";
};
function harness({html=searchPage(
 sample("Lecture Alpha","Science Channel","AAAAAAAAAAA"),
 sample("Lecture Beta","University","BBBBBBBBBBB")),
 tabs=[{id:3,url:"https://www.youtube.com/watch?v=XXXXXXXXXXX",incognito:false,
 discarded:false}]}={}){
 let handler=null,opened=0;
 const sent=[],calls=[],queue=[];
 const p={onMessage:{addListener(fn){handler=fn}},
   onDisconnect:{addListener(){}},
   postMessage(msg){sent.push(msg)}
 };
 const chrome={
   runtime:{connectNative(name){assert.equal(name,"org.alfred.youtube_daqueue");opened++;return p},
     onStartup:{addListener(){}},lastError:null},
   alarms:{create(){},onAlarm:{addListener(){}}},
   tabs:{async query(){return tabs},
     async update(id,opts){calls.push(["update",id,opts]);return {id,...opts}},
     async create(opts){calls.push(["create",opts]);return {id:100,...opts}},
     async sendMessage(id,msg){
       calls.push(["message",id,msg.type]);
       if(msg.type!=="getNowPlaying")throw Error("Unknown content script command");
       return {id:"AAAAAAAAAAA",title:"Lecture Alpha",channel:"Science Channel",paused:false};
     }}
 };
 const backend={
   async getQueue(){return queue.map(x=>({...x}))},
   async mutate(_inc,fn){return fn(queue)},
   async addVideo(_inc,id,hint,next){
     const at=queue.findIndex(x=>x.id===id);
     if(at>=0){
       if(!next)return {status:"duplicate"};
       if(at===0)return {status:"already-next"};
       queue.unshift(queue.splice(at,1)[0]);return {status:"moved"};
     }
     const item={id,title:hint.title,channel:hint.channel};
     if(next)queue.unshift(item);else queue.push(item);
     return {status:next?"added-next":"added"};
   }
 };
 const context={
   self:{},chrome,AbortController,URL,Date,
   crypto:{randomUUID(){return "12345678-1234-1234-1234-123456789012"}},
   setTimeout,clearTimeout,console:{warn(){}},
   fetch:async(url,options)=>{
     calls.push(["fetch",url,options.credentials]);
     if(!url.startsWith("https://www.youtube.com/results?"))throw Error("Unexpected network");
     return {ok:true,url,text:async()=>html};
   }
 };
 vm.runInNewContext(source,context,{timeout:1500});
 context.self.installAlfredDaQueueNative(backend);
 async function send(command,args={},id=1){
   const start=sent.length;
   handler({type:"alfred.youtube.request",id,command,args});
   for(let i=0;i<60 && sent.length===start;i++)
     await new Promise(resolve=>setTimeout(resolve,1));
   assert.equal(sent.length,start+1,"Expected one Native Messaging response");
   return sent[start];
 }
 return {send,calls,queue,opened:()=>opened};
}

test("fork is MIT, Chrome MV3, isolated from Music Companion",()=>{
 assert.equal(mf.manifest_version,3);
 assert.equal(mf.background.service_worker,"background.js");
 assert.equal(Object.hasOwn(mf.background,"scripts"),false);
 assert.equal(mf.permissions.includes("nativeMessaging"),true);
 assert.equal(mf.permissions.includes("alarms"),true);
 assert.equal(mf.permissions.includes("tabs"),false);
 assert.ok(mf.host_permissions.includes("*://www.youtube.com/*"));
 assert.equal(mf.host_permissions.some(x=>x.includes("music.youtube.com")),false);
 assert.ok(background.includes("self.installAlfredDaQueueNative({getQueue,addVideo,mutate});"));
 assert.ok(fs.readFileSync(dir+"LICENSE","utf8").includes("Copyright (c) 2026 Abhiram K"));
});
test("native search offers distinct indexed videos without leaking raw IDs",async()=>{
 const h=harness();
 const res=await h.send("search",{query:"lecture"},1);
 assert.equal(res.ok,true);
 assert.equal(JSON.stringify(res.data.results.map(x=>x.title)),JSON.stringify(["Lecture Alpha","Lecture Beta"]));
 assert.equal(JSON.stringify(res.data).includes("AAAAAAAAAAA"),false);
 assert.deepEqual(h.calls.filter(x=>x[0]==="fetch").map(x=>x[2]),["omit"]);
 const denied=await h.send("javascript",{code:"alert(1)"},2);
 assert.equal(denied.ok,false);
 assert.equal(denied.error,"INVALID_ARGUMENTS");
});
test("DaQueue queue operations are reused with explicit search id, no synthetic queue",async()=>{
 const h=harness();
 const found=await h.send("search",{query:"lecture"},3);
 const sid=found.data.search_id;
 const next=await h.send("queue_next",{search_id:sid,index:0},4);
 assert.equal(next.ok,true);
 assert.equal(next.data.verified_queue_change,true);
 assert.equal(next.data.queue_position,0);
 const add=await h.send("queue_add",{search_id:sid,index:1},5);
 assert.equal(add.ok,true);
 const list=await h.send("queue",{},6);
 assert.deepEqual(list.data.items.map(x=>x.title),["Lecture Alpha","Lecture Beta"]);
 const move=await h.send("queue_move",{from:1,to:0,expected_title:"Lecture Beta"},7);
 assert.equal(move.ok,true);
 assert.equal(move.data.items[0].title,"Lecture Beta");
 const reject=await h.send("queue_remove",{index:0,expected_title:"Mismatched"},8);
 assert.equal(reject.ok,false);
 assert.equal(reject.error,"STALE_QUEUE");
 const remove=await h.send("queue_remove",{index:0,expected_title:"Lecture Beta"},9);
 assert.equal(remove.ok,true);
 assert.equal(remove.data.items.length,1);
 const stale=await h.send("queue_next",{search_id:"00000000-0000-0000-0000-000000000000",index:0},10);
 assert.equal(stale.ok,false);
 assert.equal(stale.error,"SEARCH_EXPIRED");
 const clearDenied=await h.send("queue_clear",{confirm:"yes"},11);
 assert.equal(clearDenied.ok,false);
 assert.equal(clearDenied.error,"INVALID_ARGUMENTS");
 const clear=await h.send("queue_clear",{confirm:"CLEAR_QUEUE"},12);
 assert.equal(clear.ok,true);
 assert.equal(clear.data.verified_queue_empty,true);
});
test("YouTube play opens a precise watch URL and fails closed with two eligible tabs",async()=>{
 const h=harness();
 const s=await h.send("search",{query:"lecture"},1);
 const p=await h.send("play",{search_id:s.data.search_id,index:0},2);
 assert.equal(p.ok,true);
 assert.equal(p.data.verified_playback_change,false);
 const status=await h.send("status",{},22);
 assert.equal(status.ok,true);
 assert.equal(status.data.playback,"playing");
 assert.equal(status.data.verified_last_requested_playback,true);
 assert.equal(JSON.stringify(status).includes("AAAAAAAAAAA"),false);
 const nav=h.calls.filter(x=>x[0]==="update");
 assert.equal(nav.length,1);
 assert.equal(nav[0][2].url,"https://www.youtube.com/watch?v=AAAAAAAAAAA");
 const ambiguous=harness({tabs:[
   {id:3,url:"https://www.youtube.com/watch?v=XXXXXXXXXXX"},
   {id:4,url:"https://www.youtube.com/watch?v=YYYYYYYYYYY"}
 ]});
 const search=await ambiguous.send("search",{query:"lecture"},3);
 const fail=await ambiguous.send("play",{search_id:search.data.search_id,index:0},4);
 assert.equal(fail.ok,false);
 assert.equal(fail.error,"AMBIGUOUS_YOUTUBE_TABS");
});
test("search rejects missing/changed results rather than fabricating a match",async()=>{
 const h=harness({html:"<html><body>captcha or login page</body></html>"});
 const r=await h.send("search",{query:"lecture"},2);
 assert.equal(r.ok,false);
 assert.equal(r.error,"SEARCH_UNAVAILABLE");
});

test("status is read-only and declines missing YouTube watch tabs",async()=>{
 const h=harness({tabs:[]});
 const s=await h.send("status",{},1);
 assert.equal(s.ok,true);
 assert.equal(s.data.available,false);
 assert.equal(h.calls.some(x=>x[0]==="create"||x[0]==="update"),false);
});
