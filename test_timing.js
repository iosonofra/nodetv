const { resolveChannelUrl } = require('./server/services/dlstreamsResolver.js');

async function testTiming() {
    console.log("Resolving channel 40...");
    console.time('resolve_40');
    const result1 = await resolveChannelUrl('40');
    console.timeEnd('resolve_40');
    console.log("Result:", result1?.streamUrl?.substring(0, 100));
    
    console.log("\n---");
    
    console.log("Resolving channel 713 (Needs click)...");
    console.time('resolve_713');
    const result2 = await resolveChannelUrl('713');
    console.timeEnd('resolve_713');
    console.log("Result:", result2?.streamUrl?.substring(0, 100));
}

testTiming().catch(console.error);
