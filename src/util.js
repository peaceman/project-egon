const puppeteer = require('puppeteer');
const path = require('path');
const { config } = require('./config.js');

const login = async page => {
    console.debug(config);
    await page.goto(config.baseUrl);
    await page.type('#Username', config.auth.user);
    await page.type('#Password', config.auth.pass);

    const navigationPromise = page.waitForNavigation();
    await page.click('#logon');

    await navigationPromise;
};

const callWithBrowser = async fn => {
    const browser = await puppeteer.launch({headless: false, defaultViewport: {
        width: 1280,
        height: 1024,
    }});

    process.on('unhandledRejection', async error => {
        console.log('unhandledRejection', error);
        console.log('closing browser');
        await browser.close();
        process.exit(1);
    });

    // call scrape method
    await fn(browser);
};

const waitForBlockingOverlay = async page => {
    console.log('waiting for the block overlay to be hidden');
    return page.waitForSelector('body > div.blockUI.blockOverlay', {hidden: true});
};

const genUserFolder = userID => path.resolve(`${__dirname}/../export/${userID}`);

module.exports.login = login;
module.exports.callWithBrowser = callWithBrowser;
module.exports.waitForBlockingOverlay = waitForBlockingOverlay;
module.exports.genUserFolder = genUserFolder;