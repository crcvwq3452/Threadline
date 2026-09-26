#!/usr/bin/env node
const fs=require('fs')
const path=require('path')
const os=require('os')
const {createRequire}=require('module')

const root=process.cwd()
const requireTarget=createRequire(path.join(root,'package.json'))
const {chromium}=requireTarget('@playwright/test')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))

function args(){
  const a=process.argv.slice(2), out={}
  for(let i=0;i<a.length;i+=2) out[a[i].replace(/^--/,'')]=a[i+1]
  if(!out.fixture||!out.output) throw new Error('usage: run_threadline.cjs --fixture fixture.json --output out.json')
  return out
}
function ts(s){ return Date.parse(s)/1000 }
function msg(id,role,text,t){
  return {
    id, author:{role,name:null,metadata:{}}, create_time:ts(t), update_time:null,
    content:{content_type:'text',parts:[text]}, status:'finished_successfully',
    end_turn:role==='assistant'?true:null, weight:1.0, metadata:{}, recipient:'all'
  }
}
function sessionTail(s){ return String(s).replace(/^openai:/,'') }

function makeConversations(fixture){
  const bySession=new Map()
  for(const d of fixture.documents){
    if(!bySession.has(d.session_id)) bySession.set(d.session_id,[])
    bySession.get(d.session_id).push(d)
  }
  const out=[]
  for(const [sessionId,docs] of bySession){
    const cid=sessionTail(sessionId)
    const rootId=`${cid}-root`
    const userId=`${cid}-fixture-user`
    const baseTime=docs.map(d=>ts(d.timestamp)).sort((a,b)=>a-b)[0]-1
    const mapping={
      [rootId]:{id:rootId,message:null,parent:null,children:[userId]},
      [userId]:{
        id:userId,
        message:msg(userId,'user','Synthetic retrieval fixture prompt.',new Date(baseTime*1000).toISOString()),
        parent:rootId,children:[]
      }
    }
    let currentNode=null
    if(sessionId==='openai:lab-branch'){
      const active=docs.find(d=>d.branch==='active')
      const side=docs.find(d=>d.branch==='inactive')
      mapping[userId].children=[active.id,side.id]
      mapping[active.id]={id:active.id,message:msg(active.id,'assistant',active.content,active.timestamp),parent:userId,children:[]}
      mapping[side.id]={id:side.id,message:msg(side.id,'assistant',side.content,side.timestamp),parent:userId,children:[]}
      currentNode=active.id
    }else{
      docs.sort((a,b)=>ts(a.timestamp)-ts(b.timestamp))
      let parent=userId
      for(const d of docs){
        mapping[parent].children=[d.id]
        mapping[d.id]={id:d.id,message:msg(d.id,'assistant',d.content,d.timestamp),parent,children:[]}
        parent=d.id
      }
      currentNode=parent
    }
    out.push({
      id:cid,conversation_id:cid,title:`Retrieval Lab ${cid}`,
      create_time:baseTime,update_time:Math.max(...docs.map(d=>ts(d.timestamp))),
      current_node:currentNode,mapping
    })
  }
  return out
}

async function workerFor(context){
  return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000})
}
async function runtimeMessage(page,m){
  return page.evaluate(msg=>new Promise((resolve,reject)=>{
    chrome.runtime.sendMessage(msg,r=>{
      if(chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(r)
    })
  }),m)
}
async function allMemories(page){
  return page.evaluate(()=>new Promise((resolve,reject)=>{
    const q=indexedDB.open('AIMemoryDB')
    q.onerror=()=>reject(q.error)
    q.onsuccess=()=>{
      const db=q.result
      const tx=db.transaction('memories','readonly')
      const r=tx.objectStore('memories').getAll()
      r.onerror=()=>reject(r.error)
      r.onsuccess=()=>resolve(r.result)
    }
  }))
}
async function openPanel(page,worker){
  const ok=await worker.evaluate(async()=>{
    const tabs=await chrome.tabs.query({})
    const tab=tabs.find(t=>(t.url||'').startsWith('https://chatgpt.com/'))
    if(!tab?.id) return false
    await chrome.tabs.sendMessage(tab.id,{type:'OPEN_MEMORY_PANEL'})
    return true
  })
  if(!ok) throw new Error('ChatGPT tab not found')
  const panel=page.getByRole('dialog',{name:/Threadline panel/i})
  await panel.waitFor({state:'visible',timeout:15000})
  return panel
}
async function importFixture(panel,file){
  const toggle=panel.getByRole('button',{name:/Import backup/i})
  await toggle.click()
  const provider=panel.locator('button').filter({hasText:'ChatGPT (conversations.json)'}).first()
  await provider.waitFor({state:'visible',timeout:10000})
  await provider.click({noWaitAfter:true})
  const input=panel.locator('input[type="file"][accept*=".json"]').last()
  await input.setInputFiles(file)
}
function rowId(r){ return r.originalMessageId || r.id }
function slim(r){
  return {
    id:rowId(r),sessionId:r.sessionId,content:r.content,
    timestamp:r.timestamp,roundIndex:r.roundIndex,branchIndex:r.branchIndex,
    similarity:r.similarity,score:r.score,metadata:r.metadata
  }
}
function evaluate(q,rows){
  const ids=rows.map(r=>r.id)
  const expected=q.expected||[]
  let rank=null
  for(const x of expected){
    const i=ids.indexOf(x)
    if(i>=0) rank=rank==null?i+1:Math.min(rank,i+1)
  }
  let pass=true
  const reasons=[]
  if(q.must_top1 && rank!==1){pass=false;reasons.push(`expected top1, got rank=${rank}`)}
  if(q.must_top5 && (rank==null||rank>5)){pass=false;reasons.push(`expected top5, got rank=${rank}`)}
  const expectedAll=q.expected_all_top5||[]
  if(expectedAll.length){
    const top5=new Set(ids.slice(0,5))
    const missing=expectedAll.filter(x=>!top5.has(x))
    if(missing.length){pass=false;reasons.push(`expected all in top5, missing=${JSON.stringify(missing)}`)}
  }
  if(q.forbid_text && rows.some(r=>(r.content||'').includes(q.forbid_text))){
    pass=false;reasons.push(`forbidden stale text returned: ${q.forbid_text}`)
  }
  if(q.exclude_session && rows.some(r=>r.sessionId===q.exclude_session)){
    pass=false;reasons.push(`excluded session leaked after bridge filter: ${q.exclude_session}`)
  }
  return {pass,rank,reasons}
}

;(async()=>{
  const opt=args()
  const fixture=JSON.parse(fs.readFileSync(opt.fixture,'utf8'))
  const generated=path.join(os.tmpdir(),'threadline-v017-conversations.json')
  fs.writeFileSync(generated,JSON.stringify(makeConversations(fixture)))

  const build=path.join(root,'build','chrome-mv3-prod')
  const context=await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(os.tmpdir(),'threadline-v017-lab-')),
    {headless:false,args:[`--disable-extensions-except=${build}`,`--load-extension=${build}`,'--no-first-run','--no-default-browser-check']}
  )
  const worker=await workerFor(context)
  const extensionId=new URL(worker.url()).host
  await context.route('https://chatgpt.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',
    body:'<!doctype html><html><head><title>Retrieval Lab</title></head><body><main>retrieval lab</main></body></html>'
  }))
  const host=await context.newPage()
  await host.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:10000})
  await host.locator('#ai-memory-float-root').waitFor({state:'attached',timeout:15000})
  const panel=await openPanel(host,worker)
  await importFixture(panel,generated)

  const ext=await context.newPage()
  await ext.goto(`chrome-extension://${extensionId}/tabs/memory-graph.html`)
  await ext.waitForLoadState('domcontentloaded')

  const expectedIds=new Set(fixture.documents.map(d=>d.id))
  const start=Date.now()
  while(Date.now()-start<180000){
    const all=await allMemories(ext)
    const embedded=new Set(all.filter(r=>r.hasEmbedding===1 && r.embedding).map(rowId))
    if([...expectedIds].every(id=>embedded.has(id))) break
    await sleep(1000)
  }
  const all=await allMemories(ext)
  const embedded=new Set(all.filter(r=>r.hasEmbedding===1 && r.embedding).map(rowId))
  const missing=[...expectedIds].filter(id=>!embedded.has(id))
  if(missing.length) throw new Error('Threadline embeddings missing for '+JSON.stringify(missing))

  const output={engine:'threadline-v0.16',head:'7f67be4372d56edcd381c90ea8e774de4d8ab360',cases:[]}
  for(const q of fixture.queries){
    const response=await runtimeMessage(ext,{type:'SEARCH_MEMORIES',payload:{query:q.query,topK:20}})
    const raw=(response?.payload?.results||[]).map(slim)
    let rows=raw
    if(q.exclude_session) rows=raw.filter(r=>r.sessionId!==q.exclude_session)
    rows=rows.slice(0,10)
    const ev=evaluate(q,rows)
    const rawTop=raw.slice(0,5).map(r=>({id:r.id,sessionId:r.sessionId}))
    output.cases.push({
      id:q.id,query:q.query,expected:q.expected,exclude_session:q.exclude_session,
      evaluation:ev,raw_top5:rawTop,results:rows
    })
    console.log(JSON.stringify({
      engine:'threadline',case:q.id,pass:ev.pass,rank:ev.rank,
      raw_top:rawTop.map(x=>x.id),filtered_top:rows.slice(0,5).map(x=>x.id),
      reasons:ev.reasons
    }))
  }
  output.summary={
    passed:output.cases.filter(c=>c.evaluation.pass).length,
    total:output.cases.length,
    failed_cases:output.cases.filter(c=>!c.evaluation.pass).map(c=>c.id)
  }
  fs.mkdirSync(path.dirname(opt.output),{recursive:true})
  fs.writeFileSync(opt.output,JSON.stringify(output,null,2)+'\n')
  await context.close()
})().catch(e=>{console.error(e);process.exit(1)})
