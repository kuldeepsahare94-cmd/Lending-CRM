import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs'; import path from 'path';
const dist='dist';
const jsFile = fs.readdirSync(path.join(dist,'assets')).find(f=>f.endsWith('.js'));
let js = fs.readFileSync(path.join(dist,'assets',jsFile),'utf8');
// Neutralise import.meta so the bundle can run in a classic script context.
js = js.replace(/import\.meta\.env/g, '({VITE_API_BASE_URL:undefined,MODE:"production",PROD:true,DEV:false})')
       .replace(/import\.meta\.url/g, '"https://i-crm-sigma.vercel.app/"')
       .replace(/import\.meta/g, '({env:{},url:"https://i-crm-sigma.vercel.app/"})');

const errors=[];
const vc=new VirtualConsole();
vc.on('jsdomError', e=>errors.push('jsdomError: '+e.message));
vc.on('error', (...a)=>errors.push('console.error: '+a.join(' ')));
const dom=new JSDOM(fs.readFileSync(path.join(dist,'index.html'),'utf8'),
  {runScripts:'outside-only', url:'https://i-crm-sigma.vercel.app/', pretendToBeVisual:true, virtualConsole:vc});
const {window}=dom;
window.matchMedia=window.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
window.fetch=()=>Promise.reject(new Error('offline'));
window.scrollTo=()=>{};
window.addEventListener('error',e=>errors.push('window.error: '+e.message));

try { window.eval(js); }
catch(e){ errors.push(`MODULE-EVAL THROW: ${e.name}: ${e.message}`);
  if(e.stack) errors.push(e.stack.split('\n').slice(0,6).join('\n')); }

await new Promise(r=>setTimeout(r,600));
const root=window.document.getElementById('root');
console.log('--- RESULT ---');
console.log('#root children:', root?root.childNodes.length:'n/a');
console.log('rendered text:', JSON.stringify(window.document.body.textContent.trim().slice(0,140)));
if(errors.length){console.log('\n--- ERRORS ---');[...new Set(errors)].forEach(e=>console.log(e));}
else console.log('\nNo errors captured.');
