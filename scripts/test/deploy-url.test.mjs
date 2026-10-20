import assert from 'node:assert/strict';
import test from 'node:test';
import { configureDeploymentUrl } from '../deploy-url.mjs';

test('domainless installation uses the actual account subdomain for links and enables only workers.dev', async () => {
  const config = {name:'boxox',routes:[{pattern:'old.example.com',custom_domain:true}],vars:{OWNER_EMAIL:'owner@example.com'}};
  assert.equal(await configureDeploymentUrl(config,undefined,async()=>({subdomain:'test-account'})), 'https://boxox.test-account.workers.dev');
  assert.equal(config.vars.PUBLIC_URL,'https://boxox.test-account.workers.dev');
  assert.equal(config.vars.OWNER_EMAIL,'owner@example.com');
  assert.deepEqual(config.routes,[]);
  assert.equal(config.workers_dev,true);
  assert.equal(config.preview_urls,false);
});

test('custom origin keeps workers.dev and previews disabled without needing discovery', async () => {
  const config={name:'boxox'};
  await configureDeploymentUrl(config,'https://mail.example.com',async()=>{throw new Error('must not call');});
  assert.deepEqual(config.routes,[{pattern:'mail.example.com',custom_domain:true}]);
  assert.equal(config.vars.PUBLIC_URL,'https://mail.example.com');
  assert.equal(config.workers_dev,false);
  assert.equal(config.preview_urls,false);
});

test('explicit workers.dev origin must belong to the selected account and Worker', async () => {
  await assert.rejects(configureDeploymentUrl({name:'boxox'},'https://other.someone.workers.dev',async()=>({subdomain:'test-account'})),/this Worker’s address/);
  const config={name:'boxox'};
  await configureDeploymentUrl(config,'https://boxox.test-account.workers.dev',async()=>({subdomain:'test-account'}));
  assert.equal(config.workers_dev,true);
  assert.deepEqual(config.routes,[]);
});

test('missing account registration gets actionable recovery; authentication failures remain errors', async () => {
  for(const lookup of [async()=>({}),async()=>{throw Object.assign(new Error('absent'),{status:404});}]) {
    await assert.rejects(configureDeploymentUrl({name:'boxox'},undefined,lookup),/Choose your free workers.dev/);
  }
  await assert.rejects(configureDeploymentUrl({name:'boxox'},undefined,async()=>{throw Object.assign(new Error('forbidden'),{status:403});}),/forbidden/);
});

test('unsafe application origins fail before resource discovery', async () => {
  for(const origin of ['http://mail.example.com','https://mail.example.com/path','https://mail.example.com?key=abc','https://user:pass@mail.example.com','https://mail.example.com/#section','https://mail.example.com:8443']) {
    await assert.rejects(configureDeploymentUrl({name:'boxox'},origin,async()=>{assert.fail('must not call');}),/HTTPS origin/);
  }
});

test('a fresh account can initialize workers.dev through OAuth and confirm its address', async () => {
  const accountId='00000000000000000000000000000002';
  let registered;
  const config={name:'boxox'};
  const lookup=async()=>{
    if(!registered) throw Object.assign(new Error('not registered'),{status:404});
    return {subdomain:registered};
  };
  assert.equal(await configureDeploymentUrl(config,undefined,lookup,{
    accountId,createWorkersSubdomain:async name=>{registered=name;},
  }), 'https://boxox.boxox-000000000000.workers.dev');
  assert.equal(config.vars.PUBLIC_URL,'https://boxox.boxox-000000000000.workers.dev');
});

test('initialization never overwrites an existing address or follows a permission denial', async () => {
  const options={accountId:'00000000000000000000000000000002',createWorkersSubdomain:async()=>assert.fail('must not write')};
  await configureDeploymentUrl({name:'boxox'},undefined,async()=>({subdomain:'existing'}),options);
  await assert.rejects(configureDeploymentUrl({name:'boxox'},undefined,async()=>{throw Object.assign(new Error('forbidden'),{status:403});},options),/forbidden/);
});

test('a requested address must agree with the Worker and subdomain before registration', async () => {
  const absent=async()=>{throw Object.assign(new Error('absent'),{status:404});};
  const options={accountId:'00000000000000000000000000000002',requestedSubdomain:'my-mail',createWorkersSubdomain:async()=>assert.fail('must not write')};
  await assert.rejects(configureDeploymentUrl({name:'boxox'},'https://other.my-mail.workers.dev',absent,options),/this Worker/);
  await assert.rejects(configureDeploymentUrl({name:'boxox'},'https://boxox.someone.workers.dev',absent,options),/same account/);
  await assert.rejects(configureDeploymentUrl({name:'boxox'},undefined,absent,{...options,requestedSubdomain:'invalid.name'}),/valid lowercase/);
});

test('registration failures and unconfirmed writes stop deployment without changing config', async () => {
  const config={name:'boxox'};
  const absent=async()=>{throw Object.assign(new Error('absent'),{status:404});};
  const options={accountId:'00000000000000000000000000000002',createWorkersSubdomain:async()=>{throw new Error('name unavailable');}};
  await assert.rejects(configureDeploymentUrl(config,undefined,absent,options),/name unavailable/);
  let reads=0;
  await assert.rejects(configureDeploymentUrl(config,undefined,async()=>{
    if(++reads===1) return absent();
    return {subdomain:'different'};
  },{...options,createWorkersSubdomain:async()=>{}}),/not confirmed/);
  assert.deepEqual(config,{name:'boxox'});
});
