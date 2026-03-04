const m3u8Url = 'http://8yr1cw.hhkys.com/live/user/pass/417100.m3u8';
const relativeChunk = 'chunk1.ts';
const absoluteChunk = '/hls/123/chunk2.ts';

console.log('Relative:', new URL(relativeChunk, m3u8Url).href);
console.log('Absolute:', new URL(absoluteChunk, m3u8Url).href);
