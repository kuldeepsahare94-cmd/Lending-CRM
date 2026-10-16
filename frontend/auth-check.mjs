import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs'; import path from 'path';
const dist='dist';
const jsFile=fs.readdirSync(path.join(dist,'assets')).find(f=>f.endsWith('.js'));
let js=fs.readFileSync(path.join(dist,'assets',jsFile),'utf8')
  .replace(/import\.meta\.env/g,'({VITE_API_BASE_URL:undefined,MODE:"production",PROD:true,DEV:false})')
  .replace(/import\.meta\.url/g,'"x"').replace(/import\.meta/g,'({env:{},url:"x"})');
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');

const user={id:1,username:'admin',full_name:'Administrator',
  permissions:Object.fromEntries(['leads','accounts','contacts','opportunities','quotations',
   'subscriptions','tickets','tasks','settings','emails','email_campaigns','calls','documents','teams','fields','users','payments','workflows','taxes','currencies','email_settings']
   .map(m=>[m,{view:true,create:true,edit:true,delete:true,export:true}]))};

for (const route of ['/','/leads','/records/accounts','/customer-360/1','/settings','/email-campaigns']) {
  const errors=[];
  const vc=new VirtualConsole();
  vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://x.app'+route,pretendToBeVisual:true,virtualConsole:vc});
  const {window}=dom;
  window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  window.scrollTo=()=>{};
  window.localStorage.setItem('cd_token','fake.jwt.token');
  window.localStorage.setItem('cd_user', JSON.stringify(user));
  // Backend returns valid-but-empty payloads, the realistic "API up, no data" case.
  window.fetch=(url)=>Promise.resolve({ok:true,status:200,
    json:()=>Promise.resolve(String(url).includes('/auth/me')?{user}:[]),
    text:()=>Promise.resolve('[]'), headers:{get:()=>null}});
  window.addEventListener('error',e=>errors.push(e.message));
  try{ window.eval(js); }catch(e){ errors.push('EVAL: '+e.message); }
  await new Promise(r=>setTimeout(r,400));
  const txt=window.document.body.textContent.trim();
  const ok=txt.length>0 && !/Something went wrong/.test(txt);
  console.log(`${ok?'OK    ':'FAIL  '} ${route.padEnd(22)} ${txt.slice(0,60).replace(/\s+/g,' ')}`);
  if(errors.length) console.log('        ', [...new Set(errors)].slice(0,2).join(' | '));
}
