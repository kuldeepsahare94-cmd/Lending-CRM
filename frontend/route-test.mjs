process.on('unhandledRejection', () => {});
import fs from 'fs'; import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const dist='./dist';
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const jsFile=fs.readdirSync(path.join(dist,'assets')).find(f=>f.endsWith('.js'));
let js=fs.readFileSync(path.join(dist,'assets',jsFile),'utf8')
  .replace(/import\.meta\.env/g,'({VITE_API_BASE_URL:"https://api.example.com",MODE:"production",PROD:true,DEV:false})')
  .replace(/import\.meta\.url/g,'"https://x/"').replace(/import\.meta/g,'({env:{},url:""})');

const routes=['/','/login','/dashboard','/leads','/accounts','/customers','/contacts',
  '/opportunities','/quotations','/subscriptions','/tickets','/tasks','/settings',
  '/records/accounts','/records/contacts','/records/opportunities','/records/quotations',
  '/records/subscriptions','/records/tickets','/records/tasks',
  '/inbox','/email-campaigns','/customer-360/1','/call-reports','/this-does-not-exist'];

for (const route of routes) {
  const errors=[];
  const vc=new VirtualConsole();
  vc.on('jsdomError',e=>errors.push((e.stack||e.message)));
  vc.on('error',(...a)=>errors.push(a.join(' ')));
  const dom=new JSDOM(html.replace(/<script[^>]*><\/script>/g,''),{
    runScripts:'dangerously',pretendToBeVisual:true,
    url:'https://i-crm-sigma.vercel.app'+route,virtualConsole:vc});
  const w=dom.window;
  w.matchMedia=w.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
  w.scrollTo=()=>{};
  // Simulate a logged-in user so protected routes actually render
  w.localStorage.setItem('cd_token','fake.jwt.token');
  w.localStorage.setItem('cd_user',JSON.stringify({id:1,username:'admin',full_name:'Admin',
    permissions:{leads:{view:true,create:true,edit:true},accounts:{view:true},settings:{view:true,edit:true}}}));
  // All API calls fail — a failed API must NEVER blank the screen
  // Reject like a real failed request, but keep the harness alive
  w.fetch=()=>{ const p=Promise.reject(new Error('API unreachable')); p.catch(()=>{}); return p; };
  try{ w.eval(js);}catch(e){errors.push('EVAL THROW: '+(e.stack||e.message));}
  await new Promise(r=>setTimeout(r,700));
  const root=w.document.getElementById('root');
  const ok=root&&root.innerHTML.trim().length>0;
  const fatal=errors.filter(e=>!/offline|unreachable|API/i.test(e));
  console.log(`${ok?'  OK  ':'BLANK '} ${route.padEnd(28)} ${fatal.length?'<-- '+fatal[0].split('\n')[0].slice(0,110):''}`);
}
