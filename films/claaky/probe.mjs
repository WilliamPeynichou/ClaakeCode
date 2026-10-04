import { chromium } from '../../node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({args:['--use-angle=swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1080,height:1350}});
 page.on('pageerror',e=>console.error(e));
 await page.goto('http://127.0.0.1:8778/film.html');
 await page.waitForFunction(()=>window.ready);
 await page.evaluate(()=>window.ready);
 for(const [i,t] of [1.2,7.2,12,22].entries()){
   await page.evaluate(t=>window.seek(t),t);
   await page.screenshot({path:`probe/${i+1}.png`});
 }
 await page.setViewportSize({width:1080,height:1350});
 await page.evaluate(async()=>{
  const stage=document.querySelector('#stage');stage.style.display='none';
  document.body.style.width='1080px';document.body.style.height='1350px';
  const sheet=document.createElement('div');sheet.style.cssText='display:grid;grid-template-columns:540px 540px;background:#161e19';
  for(let i=1;i<=4;i++){const img=document.createElement('img');img.src=`probe/${i}.png`;img.style.width='540px';sheet.append(img);}document.body.append(sheet);
  await Promise.all([...sheet.querySelectorAll('img')].map(img=>new Promise(r=>{img.onload=r; if(img.complete)r();})));
 });
 await page.screenshot({path:'probe/sheet.jpg'});
}finally{await browser.close();}
