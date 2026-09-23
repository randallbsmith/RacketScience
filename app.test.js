import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, readState, patchField } from './store.js';
import { resetGame } from './reset-game.js';
import { initialGame, nextGame, pacificDate } from './dates.js';
import { recipients, sendReminders } from './send-reminders.js';
import { Readable } from 'node:stream';
import { createApp } from './server.js';
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'racket-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=JSON.parse(await readFile(new URL('./state.example.json',import.meta.url)));
 state.gameDate='2026-09-25';await writeState(state,dir);return dir;
}
test('independent concurrent fields survive; competing edits conflict',async t=>{
 const dir=await fixture(t);
 await Promise.all([
 patchField({gameDate:'2026-09-25',playerId:'player-1',field:'attendance',previous:null,value:'yes'},dir),
 patchField({gameDate:'2026-09-25',playerId:'player-2',field:'comments',previous:'',value:'Arriving late'},dir)
 ]);
 const state=await readState(dir);assert.equal(state.players[0].attendance,'yes');assert.equal(state.players[1].comments,'Arriving late');
 const outcomes=await Promise.allSettled(['no','maybe'].map(value=>patchField({gameDate:state.gameDate,playerId:'player-1',field:'attendance',previous:'yes',value},dir)));
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
 assert.equal(outcomes.find(o=>o.status==='rejected').reason.code,'conflict');
});
test('reset waits until 3 PM, preserves contacts/notes, is idempotent, rejects stale tabs',async t=>{
 const dir=await fixture(t);const old=await readState(dir);
 old.players[0].attendance='yes';old.players[0].comments='Old game';await writeState(old,dir);
 assert.equal((await resetGame(new Date('2026-09-25T21:59:00Z'),dir)).reset,false);
 assert.equal((await resetGame(new Date('2026-09-25T22:00:00Z'),dir)).gameDate,'2026-09-29');
 const state=await readState(dir);assert.equal(state.players[0].attendance,null);assert.equal(state.players[0].comments,'');
 assert.equal(state.notes,old.notes);assert.equal(state.players[0].email,old.players[0].email);
 await patchField({gameDate:state.gameDate,playerId:'player-1',field:'comments',previous:'',value:'New game'},dir);
 assert.equal((await resetGame(new Date('2026-09-25T23:00:00Z'),dir)).reset,false);
 assert.equal((await readState(dir)).players[0].comments,'New game');
 await assert.rejects(patchField({gameDate:old.gameDate,playerId:'player-1',field:'attendance',previous:null,value:'yes'},dir),{code:'stale_game'});
});
test('Pacific dates, weekdays, and daylight saving boundaries',()=>{
 assert.equal(initialGame(new Date('2026-09-22T21:59:00Z')),'2026-09-22');
 assert.equal(initialGame(new Date('2026-09-22T22:00:00Z')),'2026-09-25');
 assert.equal(initialGame(new Date('2026-12-22T22:59:00Z')),'2026-12-22');
 assert.equal(initialGame(new Date('2026-12-22T23:00:00Z')),'2026-12-25');
 assert.equal(pacificDate(new Date('2026-09-26T01:00:00Z')),'2026-09-25');
 assert.equal(nextGame('2026-12-29'),'2027-01-01');
 for(const [day,next] of [[21,22],[22,25],[23,25],[24,25],[25,29],[26,29],[27,29]]) assert.equal(nextGame(`2026-09-${day}`),`2026-09-${next}`);
});
test('reminders use only primary addresses and skip unknown.com',()=>{
 assert.deepEqual(recipients({players:[{email:' PERSON@EXAMPLE.COM ',alternateEmail:'alternate@example.com'},{email:'person@example.com'},{email:'guest@UNKNOWN.COM'},{email:''}]}),['person@example.com']);
});
test('dry run never delivers; actual reminder retries do not duplicate recipients',async t=>{
 const dir=await fixture(t);process.env.APP_URL='https://tennis.example.com';
 const state=await readState(dir);state.players=state.players.slice(0,1);await writeState(state,dir);
 let delivered=0;const deliver=async()=>{delivered++;};
 const options={dir,now:new Date('2026-09-24T08:00:00Z'),deliver};
 await sendReminders(options);assert.equal(delivered,0);
 await sendReminders({...options,send:true});await sendReminders({...options,send:true});assert.equal(delivered,1);
});
test('invalid field names and values are rejected',async t=>{
 const dir=await fixture(t);
 for(const [field,value] of [['__proto__',{}],['id','new'],['attendance','absolutely'],['comments',4]]) {
  await assert.rejects(patchField({gameDate:'2026-09-25',playerId:'player-1',field,previous:'',value},dir),{status:400});
 }
});
test('unauthenticated requests cannot read roster or private files',async t=>{
 const server=createApp({APP_URL:'http://localhost:3000',SESSION_SECRET:'a'.repeat(64)});
 async function request(path) {
  return new Promise(resolve=>{
   const headers={}; const req=Readable.from([]);req.url=path;req.method='GET';req.headers={};
   const res={headersSent:false,setHeader(k,v){headers[k.toLowerCase()]=v;},
    writeHead(status,extra={}){this.status=status;Object.assign(headers,Object.fromEntries(Object.entries(extra).map(([k,v])=>[k.toLowerCase(),v])));this.headersSent=true;},
    end(body){resolve({status:this.status,headers,body});}};
   server.emit('request',req,res);
  });
 }
 assert.equal((await request('/api/state')).status,401);
 for(const path of ['/','/.env','/data/state.json','/allowed-users.json']) {
  const response=await request(path);
  assert.equal(response.status,302);assert.equal(response.headers.location,'/auth/google');
 }
 assert.equal((await request('/auth/callback?state=bad&code=bad')).status,400);
});
