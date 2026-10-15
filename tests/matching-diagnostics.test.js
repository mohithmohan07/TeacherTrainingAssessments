import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMatchingDiagnosticStore,MATCHING_DIAGNOSTIC_LIMITS as limits} from '../server/matching-diagnostics.js';
test('private invalid-output diagnostics are bounded, private and exclude request fields',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'matching-diagnostics-'));
 try{
  const save=createMatchingDiagnosticStore(directory);
  const record={stage:'verification',attempt:1,error_code:'QUESTION_BANK_INVALID_EVIDENCE',error_message:'Missing candidate decision.',source_key:'source-hash',engine_signature:'engine-hash',payload:{private_answer:'response only'},content:['secret image'],credentials:'never retain'};
  const ref=await save(record);assert.deepEqual(Object.keys(ref).sort(),['id','payload_retained']);
  const filename=path.join(directory,`${ref.id}.json`),data=JSON.parse(await fs.readFile(filename,'utf8'));
  assert.deepEqual(data.payload,record.payload);assert.equal(data.credentials,undefined);assert.equal(data.content,undefined);assert.equal((await fs.stat(filename)).mode&0o777,0o600);
  const large=await save({...record,payload:{text:'x'.repeat(limits.maxBytes)}});assert.equal(large.payload_retained,false);
  assert.ok((await fs.stat(path.join(directory,`${large.id}.json`))).size<limits.maxBytes);
  const oversizedMetadata=await save({...record,error_message:'🚫'.repeat(limits.maxBytes),stage:'x'.repeat(limits.maxBytes)});
  assert.ok((await fs.stat(path.join(directory,`${oversizedMetadata.id}.json`))).size<=limits.maxBytes);
  await fs.utimes(filename,new Date(0),new Date(0));await save(record);await assert.rejects(fs.stat(filename),{code:'ENOENT'});
  await Promise.all(Array.from({length:45},()=>save(record)));assert.equal((await fs.readdir(directory)).length,limits.maxFiles);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('diagnostics reject symlink and permissive existing destinations',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'matching-diagnostics-path-'));
 try{
  const served=path.join(root,'uploads');await fs.mkdir(served,{mode:0o700});
  const link=path.join(root,'private-link');await fs.symlink(served,link);
  const record={payload:{private:'answer'}};
  await assert.rejects(createMatchingDiagnosticStore(link)(record),/secure/);assert.deepEqual(await fs.readdir(served),[]);
  const insecure=path.join(root,'insecure');await fs.mkdir(insecure,{mode:0o755});await assert.rejects(createMatchingDiagnosticStore(insecure)(record),/secure/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
