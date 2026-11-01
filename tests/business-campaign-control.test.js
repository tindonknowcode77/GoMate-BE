import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('manual campaigns expose one stable group per consumer, scoped chat, and owner/Admin withdrawal/deletion', async t => {
  const mongo=await MongoMemoryServer.create();t.after(()=>mongo.stop())
  const client=createClient(readConfig({MONGODB_URI:mongo.getUri('campaign_controls')}));await client.connect();t.after(()=>client.close())
  const db=client.db();await initializeDatabase(db)
  const auth=createAuthRepository(db),activities=createActivityRepository(db),chat=createChatRepository(db),users=[],tokens=[]
  for(const [i,role] of ['user','admin','user','user','user','user','user'].entries()){
    const user=await auth.createUser({name:'Campaign user '+i,email:`campaign${i}@example.com`,passwordHash:'hash'});users.push(user);tokens.push(newToken())
    await db.collection('users').updateOne({id:user.id},{$set:{role,email_verified:true,birthDate:'2000-01-01',gender:'other',languages:['Tiếng Việt']}})
    await auth.createSession({userId:user.id,tokenHash:hashToken(tokens[i]),expiresAt:new Date(Date.now()+600000)})
  }
  await db.collection('business_applications').insertMany([0,6].map(i=>({id:'business'+i,ownerId:users[i].id,company:'Company '+i,status:'approved'})))
  const server=createApp(readConfig({}),{authRepository:auth,activityRepository:activities,chatRepository:chat}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)))
  const call=async(who,path,method='GET',body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{Authorization:'Bearer '+tokens[who],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:response.status===204?null:await response.json()}}
  const ok=(value,status=200)=>{assert.equal(value.status,status,JSON.stringify(value.body));return value.body}
  const event={category:'Workshop',location:'12 Nguyễn Huệ',address:'12 Nguyễn Huệ',province:'TP. Hồ Chí Minh',meetingPoint:'Quán mới',startsAt:new Date(Date.now()+2*86400000).toISOString(),endsAt:new Date(Date.now()+2*86400000+7200000).toISOString(),estimatedCost:100000,maxParticipants:7}
  assert.equal(ok(await call(0,'/portal/locations')).total,0)
  let post=ok(await call(0,'/portal/posts','POST',{title:'Campaign one card',copy:'Shared information for all groups',premium:false,border:'Solid',badge:'',discount:'',groups:[7,7,6].map((maxParticipants,index)=>({name:'Group '+index,locationId:'',depositAmount:0,event:{...event,maxParticipants}}))}),201)
  post=ok(await call(1,`/portal/posts/${post.id}`,'PATCH',{status:'approved',version:post.version}))
  const rows=await db.collection('activities').find({businessPostId:post.id}).sort({businessGroupName:1}).toArray()
  assert.deepEqual(rows.map(row=>row.maxParticipants),[7,7,6]);assert.equal(rows.reduce((sum,row)=>sum+row.maxParticipants-row.memberCount,0),20)
  assert.ok(rows.every(row=>row.title===post.title&&row.location===event.location&&!row.coordinates))
  const location=ok(await call(0,'/portal/locations','POST',{name:'Quán mới',address:event.location,city:event.province,phone:''}),201);assert.equal(location.latitude,undefined)
  const searches=await Promise.all(Array.from({length:5},()=>call(3,'/activities?organizerType=business&q=Campaign&limit=1')))
  const selected=ok(searches[0]).items[0].id
  for(const result of searches){const body=ok(result);assert.equal(body.total,1);assert.equal(body.hasMore,false);assert.equal(body.items[0].id,selected)}
  assert.equal(ok(await call(3,'/activities?organizerType=business&q=Campaign&page=2&limit=1')).items.length,0)
  const sibling=rows.find(row=>row.id!==selected)
  await db.collection('users').updateOne({id:users[3].id},{$set:{favorite_activity_ids:rows.map(row=>row.id)}})
  assert.equal(ok(await call(3,'/me/favorites?limit=1')).total,1)
  ok(await call(3,`/activities/${sibling.id}`),404);ok(await call(3,`/activities/${sibling.id}/join-requests`,'POST',{}),404)
  const feed=ok(await call(3,'/portal/feed'));assert.equal(feed.items[0].groups.length,1);assert.equal(feed.items[0].groups[0].activityId,selected)
  const request=ok(await call(3,`/activities/${selected}/join-requests`,'POST',{}),201).request
  ok(await call(0,`/activities/${selected}/join-requests/${request.id}`,'PATCH',{status:'approved'}))
  let grant=ok(await call(0,'/portal/staff','POST',{name:'Coordinator',email:'campaign.employee@example.com',password:'Employee123!',phone:'0901234567',title:'Group manager',groupIds:[selected]}),201)
  users[2]=await db.collection('users').findOne({id:grant.userId})
  tokens[2]=ok(await call(0,'/auth/login','POST',{email:users[2].email,password:'Employee123!'})).accessToken
  const conversation=ok(await call(0,'/conversations','POST',{type:'group',activityId:selected})).conversation
  assert.equal(ok(await call(2,'/conversations','POST',{type:'group',activityId:selected})).conversation.id,conversation.id)
  ok(await call(2,'/conversations','POST',{type:'group',activityId:sibling.id}),403)
  ok(await call(4,'/conversations','POST',{type:'group',activityId:selected}),403)
  ok(await call(0,`/conversations/${conversation.id}/messages`,'POST',{text:'Welcome from owner',clientMessageId:'owner-message'}))
  ok(await call(2,`/conversations/${conversation.id}/messages`,'POST',{text:'Staff reply',clientMessageId:'staff-message'}))
  assert.ok(ok(await call(3,`/conversations/${conversation.id}/messages`)).items.some(message=>message.text==='Staff reply'))
  ok(await call(2,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'delete'}),403)
  ok(await call(6,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'delete'}),404)
  post=ok(await call(0,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'withdraw',groupId:selected}))
  assert.equal(ok(await call(3,'/activities?organizerType=business&q=Campaign')).total,0)
  ok(await call(3,`/activities/${sibling.id}`),404)
  assert.ok(ok(await call(3,`/conversations/${conversation.id}/messages`)).items.length)
  ok(await call(3,`/conversations/${conversation.id}/messages`,'POST',{text:'No sending after withdrawal',clientMessageId:'closed-message'}),409)
  ok(await call(0,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version-1,action:'delete'}),409)
  post=ok(await call(1,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'delete',groupId:sibling.id}))
  assert.equal((await db.collection('activities').findOne({id:sibling.id})).status,'deleted')
  post=ok(await call(1,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'withdraw'}))
  assert.equal(post.status,'withdrawn');assert.equal(ok(await call(5,'/activities?organizerType=business')).total,0)
  await auth.portal.reconcilePublications();assert.equal(await db.collection('activities').countDocuments({businessPostId:post.id,status:'published'}),0)
  post=ok(await call(0,`/portal/posts/${post.id}/lifecycle`,'POST',{version:post.version,action:'delete'}))
  assert.equal(post.status,'deleted');assert.equal(ok(await call(0,'/portal/posts')).total,0)
  assert.equal(await db.collection('activities').countDocuments({businessPostId:post.id,status:'deleted'}),3)
  ok(await call(2,`/conversations/${conversation.id}/messages`),403)
  // A committed withdrawal must remain hidden and recover chat/notifications after a storage interruption.
  let retryPost=ok(await call(0,'/portal/posts','POST',{title:'Recover withdrawn campaign',copy:'Durable lifecycle recovery',premium:false,border:'Solid',badge:'',discount:'',groups:[{name:'Recovery group',locationId:'',depositAmount:0,event}]}),201)
  retryPost=ok(await call(1,`/portal/posts/${retryPost.id}`,'PATCH',{status:'approved',version:retryPost.version}))
  const retryGroup=retryPost.groups[0].activityId
  ok(await call(5,`/activities/${retryGroup}/join-requests`,'POST',{}),201)
  const original=db.collection.bind(db)
  db.collection=name=>{const collection=original(name);if(name==='chat_messages')collection.updateOne=async()=>{throw Error('Simulated delivery failure')};return collection}
  try{ok(await call(0,`/portal/posts/${retryPost.id}/lifecycle`,'POST',{version:retryPost.version,action:'withdraw'}),500)}finally{db.collection=original}
  assert.equal(ok(await call(5,'/activities?q=Recover')).total,0)
  assert.ok(await db.collection('business_posts').findOne({id:retryPost.id,'lifecycleTasks.0':{$exists:true}}))
  await auth.portal.reconcilePublications();await auth.portal.reconcilePublications()
  assert.equal(await db.collection('chat_messages').countDocuments({text:'Nhóm đã được thu hồi.',senderId:users[0].id}),2) // one event per withdrawn campaign group with chat history
  assert.ok(await db.collection('notifications').findOne({userId:users[5].id,key:'business-group-withdraw:'+retryGroup}))
  assert.equal((await db.collection('activities').findOne({id:retryGroup})).status,'cancelled')
  assert.equal(await db.collection('business_posts').countDocuments({id:retryPost.id,'lifecycleTasks.0':{$exists:true}}),0)
})
