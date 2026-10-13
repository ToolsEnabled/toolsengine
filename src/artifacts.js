import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';

export const ARTIFACT_LIMITS = Object.freeze({ files: 256, bytes: 64*1024*1024, fileBytes: 16*1024*1024, downloads: 32 });
const raw = { writeFile: fs.writeFile.bind(fs), appendFile: fs.appendFile.bind(fs), rename: fs.rename.bind(fs) };
const budgets = new Set();
let installed = false;
const inside = (outer,inner) => { const rel=path.relative(outer,inner);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel)); };
function installWrites() {
  if (installed) return; installed=true;
  for (const name of ['writeFile','appendFile']) fs[name] = async (file,data,options) => {
    if (typeof file !== 'string') return raw[name](file,data,options);
    const absolute=path.resolve(file);const budget=[...budgets].find(item=>item.matches(absolute));
    return budget ? budget.write(absolute,data,{append:name==='appendFile',options}) : raw[name](file,data,options);
  };
}
function plainParents(file) {
  let cursor=path.parse(file).root;
  for(const part of path.dirname(file).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);const stat=sync.lstatSync(cursor);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Artifact parent is not a plain directory.');
  }
}
export async function createArtifactBudget(workspace, limits = ARTIFACT_LIMITS) {
  for(const key of Object.keys(ARTIFACT_LIMITS)) if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>ARTIFACT_LIMITS[key])throw new Error('Invalid artifact limit.');
  const root=await fs.realpath(workspace),output=path.join(root,'artifacts','toolsengine'),runtime=path.join(root,'.toolsengine-runtime');
  for(const directory of [path.join(root,'artifacts'),output,runtime]) {
    try{const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Artifact directory is not plain.');}
    catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(directory,{mode:0o700});}
    plainParents(path.join(directory,'check'));
  }
  const ledger=path.join(runtime,'artifact-index.json');const tracked=new Map(),notes=[];let pendingFiles=0,pendingBytes=0,pendingDownloads=0,chain=Promise.resolve(),closed=false;
  const loadIndex=()=>{
    try {
      plainParents(ledger);const stat=sync.lstatSync(ledger);
      if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error('Artifact index is not a bounded plain file.');
      let rows;try{rows=JSON.parse(sync.readFileSync(ledger,'utf8'));}catch{throw new Error('Artifact index is invalid.');}
      if(!Array.isArray(rows)||rows.length>limits.files)throw new Error('Invalid artifact index.');
      for(const row of rows){if(!row||typeof row.path!=='string'||!inside(root,path.resolve(root,row.path)))throw new Error('Invalid artifact index path.');tracked.set(path.resolve(root,row.path),row.kind==='download'?'download':'artifact');}
    } catch(error){if(error.code!=='ENOENT')throw error;}
  };
  loadIndex();
  const outputLock=path.join(runtime,'artifact-write.lock');
  const acquireOutput=async()=>{
    let handle;
    try{handle=await fs.open(outputLock,sync.constants.O_WRONLY|sync.constants.O_CREAT|sync.constants.O_EXCL|(sync.constants.O_NOFOLLOW||0),0o600);}
    catch(error){if(error.code==='EEXIST')throw new Error('Another artifact writer is active or its output lock needs review; nothing was saved.');throw error;}
    const identity=await handle.stat({bigint:true});
    return async()=>{await handle.close();const current=await fs.lstat(outputLock,{bigint:true});if(current.isFile()&&current.nlink===1n&&current.dev===identity.dev&&current.ino===identity.ino&&identity.ino!==0n)await fs.unlink(outputLock);else throw new Error('Artifact output lock identity changed; it was preserved.');};
  };
  const inspect=()=>{
    loadIndex();const files=new Map();
    const scan=directory=>{for(const name of sync.readdirSync(directory)){const file=path.join(directory,name),stat=sync.lstatSync(file);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||stat.isFile()&&stat.nlink!==1)throw new Error('Artifact inventory contains a link or nonregular file.');if(stat.isDirectory())scan(file);else files.set(file,stat.size);if(files.size>limits.files)throw new Error('Saved artifact number limit reached.');}};
    scan(output);
    for(const [file] of tracked){try{plainParents(file);const stat=sync.lstatSync(file);if(!stat.isFile()||stat.nlink!==1)throw new Error('Saved artifact is not a plain file.');files.set(file,stat.size);}catch(error){if(error.code==='ENOENT')tracked.delete(file);else throw error;}}
    const bytes=[...files.values()].reduce((sum,size)=>sum+size,0);return {files,bytes,downloads:[...tracked.values()].filter(kind=>kind==='download').length};
  };
  const persist=async()=>{
    plainParents(ledger);try{const stat=await fs.lstat(ledger);if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact index is not plain.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const rows=[...tracked].map(([file,kind])=>({path:path.relative(root,file),kind}));const temp=ledger+'.'+process.pid+'.new';
    await raw.writeFile(temp,JSON.stringify(rows)+'\n',{flag:'wx',mode:0o600});try{await raw.rename(temp,ledger);}finally{await fs.rm(temp,{force:true});}
  };
  const budget={
    output,limits,note(text){if(notes.length<8)notes.push(text);},takeNotes(){return notes.splice(0);},
    matches:file=>!closed&&(inside(output,file)||tracked.has(file)),
    addOutput(file){inspect();if(tracked.size>=limits.files&&!tracked.has(path.resolve(file)))throw new Error('Saved artifact number limit reached.');if(!inside(root,path.resolve(file)))throw new Error('Artifact output leaves workspace.');tracked.set(path.resolve(file),'artifact');},
    write(file,data,{append=false,options,kind='artifact'}={}){
      const operation=async()=>{
        if(closed)throw new Error('Artifact writer was closed.');plainParents(file);
        const release=await acquireOutput();
        try {
        const state=inspect();let existing=0;
        try{const stat=await fs.lstat(file);if(!append||!tracked.has(file))throw new Error('Output already exists; choose a new filename.');if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact file is not plain.');existing=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}
        const bytes=typeof data==='string'?Buffer.byteLength(data,typeof options==='string'?options:options?.encoding):Buffer.byteLength(data);
        const fresh=!state.files.has(file);
        if(existing+bytes>limits.fileBytes||state.bytes+bytes+pendingBytes>limits.bytes||state.files.size+(fresh?1:0)+pendingFiles>limits.files)throw new Error('Saved artifact size or number limit reached; nothing was saved.');
        if(kind==='download'&&state.downloads>=limits.downloads)throw new Error('Saved download number limit reached.');
        const prospective=new Map(tracked);prospective.set(file,kind);
        const metadata=JSON.stringify([...prospective].map(([saved,type])=>({path:path.relative(root,saved),kind:type})))+'\n';
        if(Buffer.byteLength(metadata)>65536)throw new Error('Artifact index size limit reached; nothing was saved.');
        // Append only to tracked artifacts. New output uses wx.
        let identity;
        const handle=await fs.open(file,append?sync.constants.O_WRONLY|sync.constants.O_APPEND|(sync.constants.O_NOFOLLOW||0)|(!state.files.has(file)?sync.constants.O_CREAT|sync.constants.O_EXCL:0):'wx',0o600);
        try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact file is not plain.');identity=await handle.stat({bigint:true});await handle.writeFile(data,options);}finally{await handle.close();}
        tracked.set(file,kind);
        try{await persist();}catch(error){
          if(fresh){const current=await fs.lstat(file,{bigint:true}).catch(()=>null);if(current?.isFile()&&current.nlink===1n&&current.dev===identity.dev&&current.ino===identity.ino&&identity.ino!==0n)await fs.unlink(file);tracked.delete(file);}
          throw error;
        }
        } finally {await release();}
      };
      const result=chain.then(operation);chain=result.catch(()=>{});return result;
    },
    reserveDownload(){
      const state=inspect();
      if(state.downloads+pendingDownloads>=limits.downloads||state.files.size+pendingFiles>=limits.files||state.bytes+pendingBytes+limits.fileBytes>limits.bytes)throw new Error('Download count or size limit reached; download refused.');
      pendingFiles++;pendingBytes+=limits.fileBytes;pendingDownloads++;let released=false;
      return {release(){if(!released){released=true;pendingFiles--;pendingBytes-=limits.fileBytes;pendingDownloads--;}}};
    },
    writeDownload(file,data){return budget.write(file,data,{kind:'download'});},
    async close(){await chain;closed=true;budgets.delete(budget);},
  };
  inspect();installWrites();budgets.add(budget);return budget;
}
