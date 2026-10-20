import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMailStorage, prepareMailBuckets } from '../deploy-storage.mjs';

test('inactive R2 gives the account checkout handoff without attempting a subscription', async () => {
  const calls=[];
  await assert.rejects(checkMailStorage(async(method,path)=>{
    calls.push([method,path]);
    throw Object.assign(new Error('R2 disabled'),{status:403,codes:[10042]});
  },'fresh-account'),/fresh-account\/r2\/overview.*checkout.*overages.*not created/);
  assert.deepEqual(calls,[['GET','/r2/buckets?per_page=1']]);
});

test('R2 permission and network failures stay failures', async () => {
  for(const error of [Object.assign(new Error('forbidden'),{status:403,codes:[10000]}),new Error('network')]) {
    await assert.rejects(checkMailStorage(async()=>{throw error;},'account'),error);
  }
});

test('missing buckets are created privately and existing buckets are left intact', async () => {
  const calls=[];
  await prepareMailBuckets({r2_buckets:[{bucket_name:'existing'},{bucket_name:'new-mail'}]},async(method,path,body)=>{
    calls.push([method,path,body]);
    if(method==='GET' && path.endsWith('new-mail')) throw Object.assign(new Error('missing'),{status:404});
    return {};
  });
  assert.deepEqual(calls,[['GET','/r2/buckets/existing',undefined],['GET','/r2/buckets/new-mail',undefined],['POST','/r2/buckets',{name:'new-mail'}]]);
});

test('a denied bucket lookup does not attempt bucket creation', async () => {
  const calls=[];
  await assert.rejects(prepareMailBuckets({r2_buckets:[{bucket_name:'mail'}]},async(method)=>{
    calls.push(method);
    throw Object.assign(new Error('denied'),{status:403});
  }),/denied/);
  assert.deepEqual(calls,['GET']);
});

test('the actual deployment helper stops on inactive R2 before any resource write', () => {
  const directory=mkdtempSync(join(tmpdir(),'boxox-install-preflight-'));
  try {
    const log=join(directory,'requests.jsonl');
    const loader=join(directory,'fake-cloudflare.mjs');
    writeFileSync(loader,`import {appendFileSync} from 'node:fs';
globalThis.fetch=async(url,options)=>{
  appendFileSync(${JSON.stringify(log)},JSON.stringify({url,method:options.method})+'\\n');
  const missing=url.endsWith('/workers/scripts/boxox/settings');
  return new Response(JSON.stringify({success:false,errors:[{code:missing?10007:10042}]}),{status:missing?404:403,headers:{'content-type':'application/json'}});
};`);
    const result=spawnSync(process.execPath,['--import',loader,'scripts/prepare-deploy.mjs'],{
      cwd:new URL('../../',import.meta.url),encoding:'utf8',
      env:{PATH:process.env.PATH,HOME:process.env.HOME,CF_ACCOUNT_ID:'00000000000000000000000000000002',OWNER_EMAIL:'owner@example.com',CLOUDFLARE_API_TOKEN:'offline-test-fixture',BOXOX_PLAN:'free',BOXOX_DEPLOY_DIR:join(directory,'deploy')},
    });
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/Enable R2.*00000000000000000000000000000002\/r2\/overview/);
    const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,2);
    assert.ok(calls.every(call=>call.method==='GET'),'No registration, bucket, D1, KV or queue mutations before R2 activation');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
