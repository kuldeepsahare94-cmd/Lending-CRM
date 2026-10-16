process.on('unhandledRejection',()=>{});
import fs from 'fs'; import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
const dist='./dist';
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const jsFile=fs.readdirSync(path.join(dist,'assets')).find(f=>f.endsWith('.js'));
let js=fs.readFileSync(path.join(dist,'assets',jsFile),'utf8')
 .replace(/import\.meta\.env/g,'({VITE_API_BASE_URL:"https://api.example.com",PROD:true})')
 .replace(/import\.meta\.url/g,'"https://x/"').replace(/import\.meta/g,'({env:{},url:""})');
const vc=new VirtualConsole();
const dom=new JSDOM(html.replace(/<script[^>]*><\/script>/g,''),{runScripts:'dangerously',
 pretendToBeVisual:true,url:'https://i-crm-sigma.vercel.app/leads',virtualConsole:vc});
const w=dom.window;
w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
w.scrollTo=()=>{};
w.localStorage.setItem('cd_token','t');
w.localStorage.setItem('cd_user',JSON.stringify({id:1,username:'admin',full_name:'Admin',
  permissions:{leads:{view:true,create:true},accounts:{view:true}}}));
w.fetch=()=>{const p=Promise.reject(new Error('API down'));p.catch(()=>{});return p;};
w.eval(js);
await new Promise(r=>setTimeout(r,900));
const d=w.document, body=d.body.innerHTML;
console.log('Rendered with ALL APIs failing:');
console.log('  app mounted            :', d.getElementById('root').innerHTML.length>0?'yes':'NO');
console.log('  page heading present   :', /Leads/.test(body)?'yes':'no');
console.log('  hamburger / drawer btn :', d.querySelector('[aria-label="Open navigation"]')?'yes':'NO');
console.log('  global search present  :', /Search leads/i.test(body)?'yes':'no');
console.log('  error state shown      :', /Unable to load|No leads|error/i.test(body)?'yes (graceful)':'no');
console.log('  NOT a blank screen     :', d.getElementById('root').innerHTML.length>500?'yes':'NO');
// open the drawer
const btn=d.querySelector('[aria-label="Open navigation"]');
if(btn){ btn.dispatchEvent(new w.MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,250));
  console.log('  drawer opens on click  :', d.querySelector('[role="dialog"][aria-label="Navigation"]')?'yes':'NO'); }
