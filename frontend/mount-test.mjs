import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const dist = './dist';
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsFile = fs.readdirSync(path.join(dist, 'assets')).find(f => f.endsWith('.js'));
let js = fs.readFileSync(path.join(dist, 'assets', jsFile), 'utf8');
// jsdom evaluates as a classic script, so import.meta must be stubbed.
js = js.replace(/import\.meta\.env/g, '({VITE_API_BASE_URL:"https://api.example.com",MODE:"production",PROD:true,DEV:false})')
       .replace(/import\.meta\.url/g, '"https://i-crm-sigma.vercel.app/"')
       .replace(/import\.meta/g, '({env:{},url:""})');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ''), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://i-crm-sigma.vercel.app/',
  virtualConsole: vc,
});

// Minimal browser APIs jsdom lacks that the app may touch at startup
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
dom.window.fetch = () => Promise.reject(new Error('offline in test'));
dom.window.scrollTo = () => {};

try {
  dom.window.eval(js);
} catch (e) {
  errors.push('THROW DURING MODULE EVAL: ' + (e.stack || e.message));
}

await new Promise(r => setTimeout(r, 900));

const root = dom.window.document.getElementById('root');
const mounted = root && root.innerHTML.trim().length > 0;

console.log('=== ROOT MOUNTED:', mounted ? 'YES' : 'NO (WHITE SCREEN)', '===');
if (!mounted) {
  console.log('root innerHTML length:', root ? root.innerHTML.length : 'no #root element');
}
if (errors.length) {
  console.log('\n=== ERRORS ===');
  errors.slice(0, 5).forEach(e => console.log(e.slice(0, 1600) + '\n---'));
} else {
  console.log('(no errors captured)');
}
