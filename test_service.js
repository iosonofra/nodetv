const { resolveChannelUrl } = require('./server/services/dlstreamsResolver.js');

(async () => {
    try {
        console.log('Resolving DLStreams channel 13...');
        const result = await resolveChannelUrl(13);
        console.log('Result:', result);
    } catch (e) {
        console.error(e);
    }
})();
