import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs'; import path from 'path';
const dist='dist';
const jsFile=fs.readdirSync(path.join(dist,'assets')).find(f=>f.endsWith('.js'));
let js=fs.readFileSync(path.join(dist,'assets',jsFile),'utf8')
  .replace(/import\.meta\.env/g,'({VITE_API_BASE_URL:undefined,MODE:"production",PROD:true,DEV:false})')
  .replace(/import\.meta\.url/g,'"https://i-crm-sigma.vercel.app/"')
  .replace(/import\.meta/g,'({env:{},url:"x"})');
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');

const routes=['/','/login','/dashboard','/leads','/accounts','/records/accounts','/records/contacts',
  '/records/opportunities','/records/quotations','/records/subscriptions','/records/tickets',
  '/records/tasks','/settings','/inbox','/email-campaigns','/customer-360/1','/call-reports'];

let failures=0;
for (const route of routes) {
  const errors=[];
  const vc=new VirtualConsole();
  vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://i-crm-sigma.vercel.app'+route,
    pretendToBeVisual:true,virtualConsole:vc});
  const {window}=dom;
  window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  // Simulate a totally dead backend: every API call rejects.
  window.fetch=()=>Promise.reject(new Error('backend unreachable'));
  window.scrollTo=()=>{};
  window.addEventListener('error',e=>errors.push(e.message));
  try{ window.eval(js); }catch(e){ errors.push('EVAL: '+e.message); }
  await new Promise(r=>setTimeout(r,250));
  const root=window.document.getElementById('root');
  const kids=root?root.childNodes.length:0;
  const txt=window.document.body.textContent.trim();
  const ok = kids>0 && txt.length>0;
  if(!ok) failures++;
  console.log(`${ok?'RENDERS':'BLANK  '}  ${route.padEnd(26)} ${txt.slice(0,52).replace(/\s+/g,' ')}`);
  if(errors.length && !ok) console.log('          errors:', [...new Set(errors)].slice(0,2).join(' | '));
}
console.log(failures? `\n${failures} route(s) blank` : '\nAll routes render with the backend completely unreachable.');
process.exit(failures?1:0);
