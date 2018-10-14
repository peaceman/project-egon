require('dotenv').config({ debug: process.env.DEBUG });

const config = {
    baseUrl: process.env.BASE_URL,
    segmentUrl: process.env.SEGMENT_PATH,
    auth: {
        user: process.env.AUTH_USERNAME,
        pass: process.env.AUTH_PASSWORD,
    },
};

module.exports.config = config;