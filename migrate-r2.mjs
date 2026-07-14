import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { readFileSync, readdirSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(process.env.HOME+'/.config/skate-poster/env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const s3 = new S3Client({ region:'auto', endpoint: env.R2_ENDPOINT, credentials:{ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }});
const have = new Set();
let tok;
do { const r = await s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix:'queue/', ContinuationToken: tok })); (r.Contents??[]).forEach(o=>have.add(o.Key.replace('queue/',''))); tok = r.NextContinuationToken; } while (tok);
const dir = process.env.HOME + '/Projects/skate-poster/staged';
const files = readdirSync(dir).filter(f => f.endsWith('.mp4') && !have.has(f)).sort();
console.log('already in R2:', have.size, '| to upload:', files.length);
let up = 0;
for (const f of files) {
  await s3.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: 'queue/' + f, Body: readFileSync(dir + '/' + f), ContentType: 'video/mp4' }));
  up++; if (up % 25 === 0) console.log('uploaded', up, '/', files.length);
}
console.log('DONE migrated', up, '| total in R2:', have.size + up);
