const { resolveChannelUrl } = require('./server/services/dlstreamsResolver');

(async () => {
    // Testing channel 870 (Benevento vs Foggia)
    const channelId = '870';
    console.log(`Testing channel ${channelId}...`);
    const result = await resolveChannelUrl(channelId);
    console.log(JSON.stringify(result, null, 2));
})();
