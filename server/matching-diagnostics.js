// Invalid model outputs may contain private answer text. Keep them outside all
// served upload paths, with bounded retention and no public read endpoint.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const MATCHING_DIAGNOSTIC_LIMITS = Object.freeze({maxFiles:40,maxBytes:256*1024,maxAgeMs:7*24*60*60*1000});
export function createMatchingDiagnosticStore(directory) {
  let tail=Promise.resolve();
  return record=>{
    const save=async()=>{
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const directoryStat=await fs.lstat(directory);
      if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||(directoryStat.mode&0o077)!==0||await fs.realpath(directory)!==path.resolve(directory))throw new Error('Private diagnostic directory is not a secure, direct filesystem directory.');
      const now=Date.now(), files=[];
      for(const name of await fs.readdir(directory)){
        if(!/^[0-9a-f-]{36}\.json$/.test(name))continue;
        const filename=path.join(directory,name), stat=await fs.lstat(filename);
        if(!stat.isFile())continue;
        if(now-stat.mtimeMs>MATCHING_DIAGNOSTIC_LIMITS.maxAgeMs)await fs.unlink(filename);
        else files.push({filename,time:stat.mtimeMs});
      }
      files.sort((a,b)=>b.time-a.time);
      for(const old of files.slice(MATCHING_DIAGNOSTIC_LIMITS.maxFiles-1))await fs.unlink(old.filename);
      const payload=JSON.stringify(record.payload), payloadBytes=Buffer.byteLength(payload);
      const bounded=(value,limit)=>typeof value==='string'?value.slice(0,limit):null;
      const saved={version:1,created_at:new Date(now).toISOString(),stage:bounded(record.stage,80),attempt:Number.isSafeInteger(record.attempt)?record.attempt:null,error_code:bounded(record.error_code,80),error_message:bounded(record.error_message,512),
        source_key:bounded(record.source_key,64),engine_signature:bounded(record.engine_signature,64),payload_sha256:createHash('sha256').update(payload).digest('hex'),payload_bytes:payloadBytes,
        payload_omitted:payloadBytes>MATCHING_DIAGNOSTIC_LIMITS.maxBytes-4096};
      if(!saved.payload_omitted)saved.payload=record.payload;
      let serialized=JSON.stringify(saved);
      if(Buffer.byteLength(serialized)>MATCHING_DIAGNOSTIC_LIMITS.maxBytes){delete saved.payload;saved.payload_omitted=true;serialized=JSON.stringify(saved);}
      if(Buffer.byteLength(serialized)>MATCHING_DIAGNOSTIC_LIMITS.maxBytes)throw new Error('Private diagnostic metadata exceeds its bound.');
      const id=randomUUID();await fs.writeFile(path.join(directory,`${id}.json`),serialized,{mode:0o600,flag:'wx'});
      return {id,payload_retained:!saved.payload_omitted};
    };
    const pending=tail.then(save);tail=pending.catch(()=>{});return pending;
  };
}
