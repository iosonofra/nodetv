const { resolveChannelUrl } = require('./server/services/dlstreamsResolver');

(async () => {
    console.log("Testing channel 713 (beIN Sports 2 Malaysia)...");
    const res = await resolveChannelUrl('713');
    console.log(res);
    process.exit(0);
})();
