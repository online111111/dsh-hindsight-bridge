import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boot,initProfile,loadProfileDirectory,readProfilePatches} from '@deepseek-ai/dsh-app-boot';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const coreNames=[
  '@deepseek-ai/dsh-llm','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
];

/** Boot installed modules and the shipped plugin patch in an isolated profile. */
export async function loadComposition(t,config,{settings=false,inheritedConfig}={}) {
  const home=await mkdtemp(join(tmpdir(),'dsh-hindsight-composition-'));
  let ctx;
  // Dispose async plugin work before removing any profile-owned files.
  t.after(async()=>{try {await ctx?.fiber.dispose();} finally {await rm(home,{recursive:true,force:true});}});
  const dir=join(home,'profiles','fixture');
  const bundleName='hindsight-test-core';
  const inheritedName='hindsight-test-inherited';
  const bundles=[bundleName,'dsh-hindsight-bridge',...(inheritedConfig?[inheritedName]:[])];
  initProfile(dir,bundles);
  await writeFile(join(home,'package.json'),JSON.stringify({name:'hindsight-test-installation',private:true}));
  const modules=join(dir,'node_modules');
  const bundle=join(modules,bundleName);
  await mkdir(bundle,{recursive:true});
  // Include anchors bare ESM imports beside cordis.yml. Give the fixture its own
  // lookup entries; never disable Loader.internal or mutate installed packages.
  await symlink(join(root,'node_modules','@deepseek-ai'),join(modules,'@deepseek-ai'),'dir');
  await symlink(root,join(modules,'dsh-hindsight-bridge'),'dir');
  await writeFile(join(bundle,'package.json'),JSON.stringify({
    name:bundleName,version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}},
  }));
  const entries=coreNames.map((name,index)=>({
    id:'core-'+index,name,...(name.endsWith('agent-loop')?{config:{agents:[]}}:{}),
  }));
  if(settings) entries.push(
    {id:'config-editor',name:'@deepseek-ai/dsh-config-editor'},
    {id:'settings',name:'@deepseek-ai/dsh-settings'},
  );
  const bundlePatches=[{insert:entries}];
  // The next bundle inserts the shipped hindsight entry, so inherited overrides
  // must follow that insertion in a separate profile layer below the user patch.
  if(inheritedConfig) {
    const inherited=join(modules,inheritedName);
    await mkdir(inherited,{recursive:true});
    await writeFile(join(inherited,'package.json'),JSON.stringify({
      name:inheritedName,version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}},
    }));
    await writeFile(join(inherited,'cordis.patch.yml'),JSON.stringify([{id:'hindsight-memory',config:inheritedConfig}]));
  }
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify(bundlePatches));
  await writeFile(join(dir,'cordis.yml'),'[]\n');
  await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify([{id:'hindsight-memory',config}]));
  const profile={
    name:'fixture',startedBundles:bundles,dir,
    patchPath:join(dir,'cordis.patch.yml'),installAnchor:join(home,'package.json'),
    cwd:home,home,overlays:[],telemetryDisabledEnv:undefined,
  };
  const loaded=loadProfileDirectory('dsh',dir,profile.installAnchor);
  assert.deepEqual(loaded.skippedBundles,[],'fixture bundles must resolve without compatibility exemptions');
  ctx=await boot('dsh',join(dir,'cordis.yml'),readProfilePatches('dsh',profile,loaded),ctx=>{
    ctx.provide('profileContext',profile);
  });
  assert.ok(ctx.get('agentLoop'),'real agentLoop must mount');
  assert.equal(ctx.get('loader').resolve('include:hindsight-memory').options.name,'dsh-hindsight-bridge');
  if(settings) {
    assert.ok(ctx.get('configEditor'),'real profile configEditor must mount');
    assert.ok(ctx.get('settings'),'real native settings must mount');
  }
  return ctx;
}

export async function waitFor(predicate,message='fixture timeout') {
  const end=Date.now()+3000;
  while(!predicate()) {
    if(Date.now()>end) throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

export function liveConfig(entry) {
  return typeof entry.fiber.config?.get==='function'?entry.fiber.config.get():entry.fiber.config;
}
