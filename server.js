import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, 'users.json');
const ADMIN_KEY_FILE = path.join(__dirname, 'admin-key.txt');
const PORT = Number(process.env.PORT || 3000);
const DEMO_MODE = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '*');
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.7-flash');
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const PAYMENT_BKASH = String(process.env.PAYMENT_BKASH || '');
const PAYMENT_NAGAD = String(process.env.PAYMENT_NAGAD || '');
const PAYMENT_SKRILL = String(process.env.PAYMENT_SKRILL || '');
const PAYMENT_BANK = String(process.env.PAYMENT_BANK || '');
const PAYMENT_BANK_SWIFT = String(process.env.PAYMENT_BANK_SWIFT || '');
const USD_BDT_RATE = Number(process.env.USD_BDT_RATE || 120);
const rateBuckets = new Map();
let paymentWriteLock = Promise.resolve();
let adminKey = '';
let firebaseReady = false;
let firebaseInitError = '';

async function getOrCreateAdminKey() {
  const envKey = String(process.env.ADMIN_KEY || '').trim();
  if (envKey) return envKey;
  try { const existing = (await fs.readFile(ADMIN_KEY_FILE, 'utf8')).trim(); if (existing) return existing; } catch {}
  const generated = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(ADMIN_KEY_FILE, generated + '\n', { mode: 0o600 });
  return generated;
}

async function initFirebase() {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = JSON.parse(await fs.readFile(path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH), 'utf8'));
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      initializeApp({ credential: applicationDefault() });
    }
    firebaseReady = true;
  } catch (e) { firebaseInitError = e.message || String(e); }
}

async function withPaymentLock(task) { const previous = paymentWriteLock; let release; paymentWriteLock = new Promise(r => { release = r; }); await previous; try { return await task(); } finally { release(); } }
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '64kb' }));
app.use((req,res,next)=>{ const key=req.ip||'unknown',now=Date.now(),bucket=rateBuckets.get(key); if(!bucket||now-bucket.start>=RATE_LIMIT_WINDOW_MS){rateBuckets.set(key,{start:now,count:1});return next();} if(++bucket.count>RATE_LIMIT_MAX)return res.status(429).json({error:'Too many requests. Please try again later.'}); next(); });

async function readDb(){try{return JSON.parse(await fs.readFile(DB,'utf8'));}catch{return {users:{},payments:[]};}}
async function writeDb(db){await fs.writeFile(DB,JSON.stringify(db,null,2));}
function ensureUser(db,uid,profile={}){ if(!db.users[uid]) db.users[uid]={credits:3,generations:0,balanceBdt:0,balanceUsd:0,name:profile.name||'',email:profile.email||'',phone:profile.phone||'',createdAt:new Date().toISOString()}; else Object.assign(db.users[uid],profile); return db.users[uid]; }
function validateInput(body){for(const f of ['topic','platform','format','language','tone'])if(!body?.[f]||typeof body[f]!=='string')return`Missing field: ${f}`;if(body.topic.trim().length<3||body.topic.length>1000)return'Topic must be between 3 and 1000 characters.';return null;}
function demoContent(input){const t=input.topic.trim();return{titles:[`5 AI Tools Every Student Should Know in 2026`,`These 5 AI Tools Will Make Students Study Smarter`,`5 Game-Changing AI Tools for Students`,`Study Smarter: 5 AI Tools You Need to Try`,`The 5 Most Useful AI Tools for Students`,`Stop Studying the Hard Way: Try These 5 AI Tools`,`5 AI Tools That Can Save Students Hours Every Week`,`Students Need These 5 AI Tools Right Now`,`I Tested 5 AI Tools for Students — Here Are the Best`,`5 Powerful AI Tools to Level Up Your Student Life`],hooks:[`What if AI could save you hours of study time every single week?`,`Most students are using AI the wrong way. Here are 5 tools that actually help.`,`Before your next study session, check out these five AI tools.`,`These tools can turn a messy study routine into a much smarter workflow.`,`If you're a student in 2026, you should know about these AI tools.`],description:`In this video, we explore ${t} and show how these tools can help students study smarter, save time, organize information and improve productivity.`,keywords:`AI tools for students, artificial intelligence, student productivity, study tools, AI study tools, education technology, productivity tools, student life, study smarter, AI apps, ${t}`,hashtags:`#AITools #Students #StudySmarter #AI #Productivity #Education #StudentLife #Tech`,thumbnailTexts:[`5 AI TOOLS`,`STUDY SMARTER`,`AI EVERY STUDENT NEEDS`,`SAVE HOURS WITH AI`,`TOP AI TOOLS 2026`],cta:`If you found this useful, subscribe and follow for more practical AI tools and productivity tips.`,socialCaption:`Want to study smarter? 🚀 Here are 5 AI tools students should know about in 2026. Save this post and share it with a student who needs it.`,shortsIdeas:[`30-second countdown: 3 AI tools every student should try`,`Before vs. after: studying with AI`,`One AI tool, one student problem, one quick solution`]};}

async function callGemini(input) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the backend.');
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });

  const prompt = `Create a high-quality content pack for a creator.
Topic: ${input.topic}
Platform: ${input.platform}
Format: ${input.format}
Language: ${input.language}
Tone: ${input.tone}

Return ONLY valid JSON with exactly these keys:
titles (array of 10 strings),
hooks (array of 5 strings),
description (string),
keywords (string),
hashtags (string),
thumbnailTexts (array of 5 strings),
cta (string),
socialCaption (string),
shortsIdeas (array of 3 strings).

Do not use markdown fences.`;

  const models = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
];

  let lastError;

  for (const model of [...new Set(models)]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(
          `Trying Gemini model: ${model}, attempt: ${attempt}`
        );

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        });

        const text = String(response.text || '').trim();

        if (!text) {
          throw new Error('Gemini returned no text.');
        }

        return JSON.parse(text);

      } catch (error) {
        lastError = error;

        const status = Number(
          error?.status ||
          error?.code ||
          error?.error?.code ||
          0
        );

        console.error(
          `Gemini ${model} attempt ${attempt} failed:`,
          error?.message || error
        );

        if (status !== 503 && status !== 429) {
          throw error;
        }

        if (attempt < 3) {
          await new Promise(resolve =>
            setTimeout(resolve, attempt * 3000)
          );
        }
      }
    }

    console.log(`Switching Gemini model after failures: ${model}`);
  }

  throw new Error(
    `All Gemini models are temporarily unavailable. Last error: ${
      lastError?.message || 'Unknown error'
    }`
  );
}
async function authMiddleware(req,res,next){
  if(!firebaseReady)return res.status(503).json({error:'Firebase backend authentication is not configured yet.'});
  const header=String(req.headers.authorization||''); const token=header.startsWith('Bearer ')?header.slice(7):'';
  if(!token)return res.status(401).json({error:'Authentication required.'});
  try{req.user=await getAuth().verifyIdToken(token,true);next();}catch(e){return res.status(401).json({error:'Invalid or expired authentication token.'});}
}
function requireVerified(req,res,next){if(req.user.email&&req.user.email_verified===false)return res.status(403).json({error:'Please verify your email before using the app.'});next();}
function adminGuard(req,res,next){if(String(req.query.key||req.headers['x-admin-key']||'')!==adminKey)return res.status(401).json({error:'Unauthorized.'});next();}

app.get('/health',(_req,res)=>res.json({ok:true,demoMode:DEMO_MODE,geminiModel:GEMINI_MODEL,firebaseReady, firebaseInitError:firebaseReady?'':firebaseInitError,adminKeyFile:ADMIN_KEY_FILE}));
app.get('/api/me',authMiddleware,requireVerified,async(req,res)=>{const db=await readDb();const u=ensureUser(db,req.user.uid,{name:req.user.name||req.user.displayName||'',email:req.user.email||'',phone:req.user.phone_number||''});await writeDb(db);res.json({uid:req.user.uid,name:u.name,email:u.email,phone:u.phone,credits:u.credits,generations:u.generations});});
app.get('/api/user/credits',authMiddleware,requireVerified,async(req,res)=>{const db=await readDb();const u=ensureUser(db,req.user.uid);await writeDb(db);res.json({credits:u.credits,generations:u.generations});});
app.post('/api/generate-content',authMiddleware,requireVerified,async(req,res)=>{const validationError=validateInput(req.body);if(validationError)return res.status(400).json({error:validationError});const db=await readDb();const u=ensureUser(db,req.user.uid);if(u.credits<=0)return res.status(402).json({error:'No credits remaining.',credits:0});try{const content=DEMO_MODE?demoContent(req.body):await callGemini(req.body);u.credits-=1;u.generations+=1;await writeDb(db);res.json({content,credits:u.credits,generations:u.generations});}catch(e){console.error(e);res.status(502).json({error:e.message||'Generation failed.'});}});
app.get('/api/payment/instructions',authMiddleware,requireVerified,(req,res)=>{const method=String(req.query.method||'').trim();const instructions={'bKash':`বিকাশ Personal নম্বর: ${PAYMENT_BKASH}।`,'Nagad':`নগদ Personal নম্বর: ${PAYMENT_NAGAD}।`,'Skrill':`Skrill account/email: ${PAYMENT_SKRILL}`,'ACH / Bank Transfer':`Bank details: ${PAYMENT_BANK}. SWIFT/BIC: ${PAYMENT_BANK_SWIFT}`};if(!instructions[method])return res.status(400).json({error:'Unsupported payment method.'});res.json({method,instruction:instructions[method],usdBdtRate:USD_BDT_RATE});});
app.get('/api/wallet',authMiddleware,requireVerified,async(req,res)=>{const db=await readDb();const u=ensureUser(db,req.user.uid);await writeDb(db);res.json({balanceBdt:Number(u.balanceBdt||0),balanceUsd:Number(u.balanceUsd||0),usdBdtRate:USD_BDT_RATE});});
app.get('/api/payments',authMiddleware,requireVerified,async(req,res)=>{const db=await readDb();const payments=(db.payments||[]).filter(x=>x.userId===req.user.uid).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));res.json({payments});});
app.post('/api/payments',authMiddleware,requireVerified,async(req,res)=>{const name=String(req.body?.name||req.user.name||req.user.email||'').trim(),method=String(req.body?.method||'').trim(),reference=String(req.body?.reference||'').trim(),account=String(req.body?.account||'').trim(),note=String(req.body?.note||'').trim(),currency=String(req.body?.currency||'BDT').trim().toUpperCase(),amount=Number(req.body?.amount),allowedMethods=['bKash','Nagad','Skrill','ACH / Bank Transfer'];if(!name||!reference||!account)return res.status(400).json({error:'Name, sender/account details and payment reference are required.'});if(!allowedMethods.includes(method))return res.status(400).json({error:'Invalid payment method.'});if(!['BDT','USD'].includes(currency))return res.status(400).json({error:'Currency must be BDT or USD.'});if(!Number.isFinite(amount)||amount<0.01||amount>10000000)return res.status(400).json({error:'Invalid deposit amount.'});const db=await readDb();ensureUser(db,req.user.uid,{name,email:req.user.email||'',phone:req.user.phone_number||''});db.payments??=[];const payment={id:`pay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,userId:req.user.uid,name,amount,currency,amountBdt:currency==='BDT'?amount:amount*USD_BDT_RATE,amountUsd:currency==='USD'?amount:amount/USD_BDT_RATE,method,reference,account,note,status:'pending',createdAt:new Date().toISOString()};db.payments.push(payment);await writeDb(db);res.status(201).json({ok:true,paymentId:payment.id,status:'pending',currency,amount});});
app.get('/api/admin/payments',adminGuard,async(_req,res)=>{const db=await readDb();res.json({payments:db.payments||[]});});
app.post('/api/admin/payments/:id/approve',adminGuard,async(req,res)=>{try{const result=await withPaymentLock(async()=>{const db=await readDb();const payment=(db.payments||[]).find(x=>x.id===req.params.id);if(!payment)return{status:404,body:{error:'Payment not found.'}};if(payment.status!=='pending')return{status:400,body:{error:'Only pending payments can be approved.'}};const user=ensureUser(db,payment.userId);const currency=String(payment.currency||'BDT').toUpperCase(),amount=Number(payment.amount||0);if(currency==='USD')user.balanceUsd=Number(user.balanceUsd||0)+amount;else if(currency==='BDT')user.balanceBdt=Number(user.balanceBdt||0)+amount;else return{status:400,body:{error:'Unsupported payment currency.'}};payment.status='approved';payment.approvedAt=new Date().toISOString();await writeDb(db);return{status:200,body:{ok:true,status:'approved',currency,amount,balanceBdt:Number(user.balanceBdt||0),balanceUsd:Number(user.balanceUsd||0)}};});res.status(result.status).json(result.body);}catch(e){console.error(e);res.status(500).json({error:'Approval could not be completed.'});}});
app.post('/api/admin/payments/:id/reject',adminGuard,async(req,res)=>{try{const result=await withPaymentLock(async()=>{const db=await readDb();const payment=(db.payments||[]).find(x=>x.id===req.params.id);if(!payment)return{status:404,body:{error:'Payment not found.'}};if(payment.status!=='pending')return{status:400,body:{error:'Only pending payments can be rejected.'}};payment.status='rejected';payment.rejectedAt=new Date().toISOString();await writeDb(db);return{status:200,body:{ok:true,status:'rejected'}};});res.status(result.status).json(result.body);}catch(e){console.error(e);res.status(500).json({error:'Rejection could not be completed.'});}});

(async()=>{adminKey=await getOrCreateAdminKey();await initFirebase();app.listen(PORT,()=>console.log(`Creator Helper backend listening on port ${PORT}; demoMode=${DEMO_MODE}; gemini=${GEMINI_MODEL}; firebaseReady=${firebaseReady}`));})();
