// Alfred YouTube DaQueue Native Messaging adapter.
// MIT fork of DaQueue (2026 Abhiram K). The original queue controller remains
// authoritative; this module reuses its addVideo/getQueue/mutate functions.
// No arbitrary browser commands, JS evaluation, cookies, account API or shell.
(() => {
  "use strict";
  const HOST = "org.alfred.youtube_daqueue";
  const RETRY = "alfred-youtube-daqueue-native-reconnect";
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const ALLOWED = new Set(["search","queue","status","play","queue_next","queue_add","queue_move","queue_remove","queue_clear"]);
  const MAX_REPLY = 32768;
  const SEARCH_TTL = 120000;
  const MAX_QUEUE = 250;
  const MAX_HTML = 5 * 1024 * 1024;
  const clean = (x,n=160) => String(x??"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,n);
  const plain = x => x && typeof x==="object" && !Array.isArray(x);
  const fail = code => {throw new Error(code)};
  let port=null,searchCache=null,lastPlayRequested=null;
  let backend=null;

  function textRuns(o) {
    return clean(o?.runs?.map(x=>x.text??"").join("") ?? o?.simpleText ?? o?.content ?? "");
  }
  // Parse one JSON assignment from YouTube's own /results HTML, with a
  // bounded balanced-brace scanner instead of brittle </script> slicing.
  function initialData(html) {
    if(typeof html!=="string" || html.length>MAX_HTML)return null;
    const markers=["var ytInitialData =","window[\"ytInitialData\"] =","window.ytInitialData =","ytInitialData ="];
    for(const marker of markers){
      const at=html.indexOf(marker);
      if(at<0)continue;
      const start=html.indexOf("{",at+marker.length);
      if(start<0||start-at>200)continue;
      let depth=0,quoted=false,escape=false;
      for(let i=start;i<html.length;i++){
        const c=html[i];
        if(quoted){
          if(escape)escape=false;
          else if(c==="\\")escape=true;
          else if(c==='"')quoted=false;
          continue;
        }
        if(c==='"'){quoted=true;continue;}
        if(c==="{")depth++;
        else if(c==="}" && --depth===0) {
          try{return JSON.parse(html.slice(start,i+1))}catch{break}
        }
      }
    }
    return null;
  }
  function searchItems(data) {
    const sections=data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents;
    if(!Array.isArray(sections))return [];
    const out=[],seen=new Set(),stack=[...sections].reverse();
    let inspected=0;
    while(stack.length && out.length<10 && inspected++<2500){
      const node=stack.pop();
      if(!plain(node))continue;
      const v=node.videoRenderer;
      if(plain(v) && ID.test(v.videoId||"") && !seen.has(v.videoId)){
        const badges=JSON.stringify(v.badges??[]);
        const isLive=/LIVE NOW|BADGE_STYLE_TYPE_LIVE_NOW|LIVE_STREAMING/i.test(badges);
        const title=textRuns(v.title);
        const channel=textRuns(v.ownerText)||textRuns(v.longBylineText)||textRuns(v.shortBylineText);
        if(title && !isLive){
          seen.add(v.videoId);
          out.push({videoId:v.videoId,title,channel});
        }
      }
      // Some YouTube experiments wrap regular videoRenderer in shelves.
      // Traverse only the visible search subtree, not entire page metadata.
      for(const [key,value] of Object.entries(node).reverse()){
        if(key==="navigationEndpoint"||key==="thumbnail"||key==="badges"||
           key==="commandMetadata"||key==="trackingParams")continue;
        if(Array.isArray(value)){
          for(let i=value.length-1;i>=0;i--) if(plain(value[i]))stack.push(value[i]);
        }else if(plain(value))stack.push(value);
      }
    }
    return out;
  }
  async function searchYouTube(query){
    const url="https://www.youtube.com/results?search_query="+encodeURIComponent(query);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(url,{credentials:"omit",redirect:"follow",
        signal:controller.signal,headers:{"Accept-Language":"en-US,en;q=0.9"}});
      if(!response.ok||new URL(response.url).origin!=="https://www.youtube.com")
        fail("SEARCH_UNAVAILABLE");
      const html=await response.text();
      const data=initialData(html);
      if(!data)fail("SEARCH_UNAVAILABLE");
      return searchItems(data);
    }catch{fail("SEARCH_UNAVAILABLE")}
    finally{clearTimeout(timer)}
  }
  function validArgs(command,args) {
    if(!ALLOWED.has(command)||!plain(args))return false;
    const keys=Object.keys(args);
    const exact=names=>keys.length===names.length && names.every(x=>Object.hasOwn(args,x));
    if(command==="status")return exact([]);
    if(command==="queue")return (exact([]) || exact(["offset","limit"])) &&
      (keys.length===0 || (Number.isInteger(args.offset)&&args.offset>=0&&args.offset<MAX_QUEUE&&
        Number.isInteger(args.limit)&&args.limit>=1&&args.limit<=50));
    if(command==="search")return exact(["query"]) && typeof args.query==="string" &&
      args.query.length<=120 && !!args.query.trim() && !/[\u0000-\u001f\u007f]/.test(args.query);
    if(["play","queue_next","queue_add"].includes(command))
      return exact(["search_id","index"]) && typeof args.search_id==="string" &&
        /^[a-f0-9-]{36}$/.test(args.search_id) && Number.isInteger(args.index) &&
        args.index>=0 && args.index<10;
    if(command==="queue_move")return exact(["from","to","expected_title"]) &&
      Number.isInteger(args.from)&&Number.isInteger(args.to) &&
      args.from>=0&&args.to>=0&&args.from<MAX_QUEUE&&args.to<MAX_QUEUE &&
      typeof args.expected_title==="string" && args.expected_title.length<=160 && !!args.expected_title;
    if(command==="queue_remove")return exact(["index","expected_title"]) &&
      Number.isInteger(args.index)&&args.index>=0&&args.index<MAX_QUEUE &&
      typeof args.expected_title==="string" && args.expected_title.length<=160 && !!args.expected_title;
    if(command==="queue_clear")return exact(["confirm"]) && args.confirm==="CLEAR_QUEUE";
    return false;
  }
  function result(id,payload){
    return {type:"alfred.youtube.response",id,...payload};
  }
  function sanitizedQueue(q,offset=0,limit=20) {
    return q.slice(offset,offset+limit).map((item,i)=>({
      index:offset+i,title:clean(item.title),channel:clean(item.channel)
    }));
  }
  function searchPick(args){
    if(!searchCache || searchCache.id!==args.search_id ||
       Date.now()-searchCache.at>SEARCH_TTL)fail("SEARCH_EXPIRED");
    const item=searchCache.rows[args.index];
    if(!item)fail("INVALID_RESULT");
    return item;
  }
  async function youtubeTab() {
    const tabs=await chrome.tabs.query({url:"https://www.youtube.com/*"});
    const normal=tabs.filter(x=>!x.incognito && !x.discarded && Number.isInteger(x.id));
    if(normal.length>1)fail("AMBIGUOUS_YOUTUBE_TABS");
    return normal[0]??null;
  }
  async function dispatch(command,args) {
    if(!validArgs(command,args))fail("INVALID_ARGUMENTS");
    if(command==="search"){
      const rows=await searchYouTube(args.query.trim());
      const id=crypto.randomUUID();
      searchCache={id,at:Date.now(),rows};
      return {search_id:id,results:rows.map((v,index)=>({
        index,title:v.title,channel:v.channel
      })),source:"youtube_public_search_page",untrusted_catalog_results:true};
    }
    if(command==="status"){
      const tab=await youtubeTab();
      if(!tab)return {available:false,reason:"NO_YOUTUBE_TAB"};
      let now;
      try{now=await chrome.tabs.sendMessage(tab.id,{type:"getNowPlaying"})}
      catch{return {available:false,reason:"CONTENT_SCRIPT_UNAVAILABLE"}}
      if(!plain(now)||!ID.test(now.id??"")||typeof now.paused!=="boolean")
        return {available:false,reason:"PLAYER_NOT_READY"};
      const matched=!!lastPlayRequested&&Date.now()-lastPlayRequested.at<SEARCH_TTL&&
        now.id===lastPlayRequested.id;
      return {available:true,title:clean(now.title),channel:clean(now.channel),
        playback:now.paused?"paused":"playing",
        matched_last_requested_video:matched,
        verified_last_requested_playback:matched&&!now.paused};
    }
    if(command==="queue"){
      const queue=await backend.getQueue(false);
      const offset=args.offset??0,limit=args.limit??20;
      return {items:sanitizedQueue(queue,offset,limit),total:queue.length,
        offset,limit,has_more:offset+limit<queue.length};
    }
    if(command==="play"){
      const item=searchPick(args);
      const tab=await youtubeTab();
      const url="https://www.youtube.com/watch?v="+item.videoId;
      if(tab)await chrome.tabs.update(tab.id,{url,active:true});
      else await chrome.tabs.create({url,active:true});
      lastPlayRequested={id:item.videoId,at:Date.now()};
      return {requested:true,action:"play",title:item.title,channel:item.channel,
        verified_playback_change:false};
    }
    if(command==="queue_next"||command==="queue_add"){
      const item=searchPick(args);
      const next=command==="queue_next";
      // Existing DaQueue code handles serialized queue writes, oEmbed metadata
      // lookup, and moving an existing item to the front without duplication.
      const reply=await backend.addVideo(false,item.videoId,
        {title:item.title,channel:item.channel},next);
      if(!["added","added-next","moved","already-next","duplicate"].includes(reply?.status))
        fail("QUEUE_MUTATION_FAILED");
      const newQueue=await backend.getQueue(false);
      const pos=newQueue.findIndex(row=>row.id===item.videoId);
      const verified=pos>=0 && (next?pos===0:true);
      return {requested:true,action:next?"queue_next":"queue_add",
        status:reply.status,queue_position:pos,verified_queue_change:verified,
        title:item.title,channel:item.channel};
    }
    if(command==="queue_move"){
      const moved=await backend.mutate(false,q=>{
        if(args.from>=q.length||args.to>=q.length) return "INDEX_UNAVAILABLE";
        if(q[args.from]?.title!==args.expected_title) return "STALE_QUEUE";
        if(args.from===args.to)return "UNCHANGED";
        q.splice(args.to,0,q.splice(args.from,1)[0]);
        return "MOVED";
      });
      if(moved==="INDEX_UNAVAILABLE"||moved==="STALE_QUEUE")fail(moved);
      const after=await backend.getQueue(false);
      return {requested:true,action:"queue_move",status:moved,
        from:args.from,to:args.to,
        verified_queue_change:moved==="MOVED"&&after[args.to]?.title===args.expected_title,
        items:sanitizedQueue(after,Math.max(0,args.to-2),5)};
    }
    if(command==="queue_remove"){
      const removed=await backend.mutate(false,q=>{
        if(args.index>=q.length)return "INDEX_UNAVAILABLE";
        if(q[args.index]?.title!==args.expected_title)return "STALE_QUEUE";
        q.splice(args.index,1);
        return "REMOVED";
      });
      if(removed!=="REMOVED")fail(removed);
      return {requested:true,action:"queue_remove",status:removed,
        items:sanitizedQueue(await backend.getQueue(false),Math.max(0,args.index-2),5)};
    }
    if(command==="queue_clear"){
      const previous=(await backend.getQueue(false)).length;
      await backend.mutate(false,q=>q.splice(0,q.length));
      return {requested:true,action:"queue_clear",removed:previous,
        verified_queue_empty:(await backend.getQueue(false)).length===0};
    }
    fail("UNKNOWN_COMMAND");
  }
  async function handle(message) {
    const reqId=message?.id;
    if(!plain(message)||message.type!=="alfred.youtube.request"||
       !Number.isSafeInteger(reqId)||reqId<1||reqId>1000000000 ||
       !validArgs(message.command,message.args))
      return result(Number.isSafeInteger(reqId)?reqId:0,
        {ok:false,error:"INVALID_ARGUMENTS"});
    try{
      const data=await dispatch(message.command,message.args);
      const payload=result(reqId,{ok:true,data});
      if(JSON.stringify(payload).length>MAX_REPLY)fail("RESPONSE_TOO_LARGE");
      return payload;
    }catch(e){
      const known=new Set(["SEARCH_UNAVAILABLE","SEARCH_EXPIRED","INVALID_RESULT",
        "INVALID_ARGUMENTS","AMBIGUOUS_YOUTUBE_TABS","QUEUE_MUTATION_FAILED",
        "INDEX_UNAVAILABLE","STALE_QUEUE","RESPONSE_TOO_LARGE"]);
      return result(reqId,{ok:false,error:known.has(e?.message)?e.message:"ACTION_FAILED"});
    }
  }
  function connect(){
    if(port)return;
    try{
      const candidate=chrome.runtime.connectNative(HOST);
      port=candidate;
      candidate.onMessage.addListener(message=>{
        handle(message).then(reply=>{
          if(port!==candidate)return;
          try{candidate.postMessage(reply)}catch{}
        });
      });
      candidate.onDisconnect.addListener(()=>{
        const error=chrome.runtime.lastError?.message;
        if(port===candidate)port=null;
        if(error)console.warn("[Alfred DaQueue] native host unavailable:",error);
      });
    }catch{port=null}
  }
  self.installAlfredDaQueueNative=function(service){
    if(backend)throw Error("Alfred DaQueue adapter duplicate initialization");
    if(!service||typeof service.getQueue!=="function"||
       typeof service.addVideo!=="function"||typeof service.mutate!=="function")
      throw Error("Alfred DaQueue backend invalid");
    backend=service;
    connect();
    chrome.runtime.onStartup.addListener(connect);
    chrome.alarms.create(RETRY,{periodInMinutes:1});
    chrome.alarms.onAlarm.addListener(alarm=>{
      if(alarm.name===RETRY)connect();
    });
  };
})();
