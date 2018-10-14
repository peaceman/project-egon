const fs = require('fs-extra');
const { login, waitForBlockingOverlay, genUserFolder } = require('./util.js');

function dumpFrameTree(frame, indent) {
    console.log(indent + frame.url());
    for (let child of frame.childFrames())
      dumpFrameTree(child, indent + '  ');
  }

const scrapeBetSlips = async (browser, options, config) => {
    const page = await browser.newPage();

    try {
        await login(page);

        // navigate to reports
        await page.goto(`${config.baseUrl}/Report`);
        await waitForBlockingOverlay(page);
        await page.click('button[action="/Report/BettingReportIndex"]');
        await waitForBlockingOverlay(page);

        // fill date filter
        await page.evaluate(() => {
            document.querySelector('#tbFrom').value = '2000/01/01 00:00';
            document.querySelector('#tbTo').value = '2030/01/01 00:00';
        });

        await page.click('#btnFilterReport');
        await waitForBlockingOverlay(page);

        // change to 100 entries per page
        await page.select('select[name=tblBettingReport_length]', '100');
        await waitForBlockingOverlay(page);

        // sort by bet slip id
        const sortAmount = options.order === 'asc' ? 1 : 2;
        for (let i = 0; i < sortAmount; i++) {
            await page.click('#tblBettingReport tbody > tr:nth-child(1)')
            await waitForBlockingOverlay(page);
        }

        const nextButtonSelector = '#tblBettingReport_next';

        while (true) {
            const tableRowElements = await page.$$('#tblBettingReport tbody > tr');

            for (const tableRowElement of tableRowElements) {
                const betSlipID = await tableRowElement.$eval(':nth-child(1)', node => node.innerText);
                const userID = await tableRowElement.$eval(':nth-child(3)', node => node.innerText);

                const betSlipsFolderPath = `${genUserFolder(userID)}/betslips`;
                await fs.ensureDir(betSlipsFolderPath);
                const targetFilePath = `${betSlipsFolderPath}/${betSlipID}.json`;
                if (await fs.pathExists(targetFilePath)) {
                    console.log('BetSlip data file already exists, skip!', {targetFilePath});
                    continue;
                }

                const loggingContext = {betSlipID, userID};
                const detailsElement = await tableRowElement.$('a');

                const detailsResponsePromise = page.waitForResponse(response => {
                    console.log('waiting for the details response', loggingContext);
                    return response.url().includes(`betSlipGroupId=${betSlipID}`);
                });
                console.log('clicking on the details button', loggingContext);
                await detailsElement.click();

                await detailsResponsePromise;

                const iframe = page.frames()[1];
                await iframe.waitForSelector('#TableBet');

                const betSlipData = {
                    status: await scrapeBetSlipStatus(iframe),
                    selections: await scrapeBetSlipSelections(iframe),
                    stakes: await scrapeBetSlipStakes(iframe),
                };
                
                fs.writeJson(targetFilePath, betSlipData, {spaces: 2});

                // close details frame
                await page.click('body > div.ui-dialog.ui-widget.ui-widget-content.ui-corner-all.ui-front.ui-draggable.ui-resizable > div.ui-dialog-titlebar.ui-widget-header.ui-corner-all.ui-helper-clearfix.ui-draggable-handle > button');
            }

            // page
            if (await page.$(`${nextButtonSelector}.disabled`) != null) {
                console.info('Reached last page');
                break;
            }

            await page.click(nextButtonSelector);
            await waitForBlockingOverlay(page);
        }
    } catch (e) {
        console.log('catched', e);
        process.exit();
    }
};

const scrapeBetSlipStatus = async iframe => {
    const statusTableRowElement = await iframe.$('#TableBet > tbody > tr.with-status');
    const betSlipStatus = {
        createdAt: await statusTableRowElement.$eval(':nth-child(1)', node => node.innerText),
        currency: await statusTableRowElement.$eval(':nth-child(2)', node => node.innerText),
        status: await statusTableRowElement.$eval(':nth-child(3)', node => node.innerText),
    };

    return betSlipStatus;
};

const scrapeBetSlipSelections = async iframe => {
    const selectionRowElements = await iframe.$$('#TableBetSelections > tbody > tr.with-status')
    const betSlipSelections = await Promise.all([...selectionRowElements].map(async sre => ({
        date: await sre.$eval(':nth-child(1)', node => node.innerText),
        event: await sre.$eval(':nth-child(2)', node => node.innerText),
        market: await sre.$eval(':nth-child(3)', node => node.innerText),
        pick: await sre.$eval(':nth-child(4)', node => node.innerText),
        status: await sre.$eval(':nth-child(5)', node => node.innerText),
    })));

    return betSlipSelections;
};

const scrapeBetSlipStakes = async iframe => {
    const stakesTableRowElement = await iframe.$('#TableBetStakes > tbody > tr.with-status');
    const betSlipStakes = {
        betType: await stakesTableRowElement.$eval(':nth-child(1)', node => node.innerText),
        noOfBets: await stakesTableRowElement.$eval(':nth-child(2)', node => node.innerText),
        unitStake: await stakesTableRowElement.$eval(':nth-child(3)', node => node.innerText),
        stake: await stakesTableRowElement.$eval(':nth-child(4)', node => node.innerText),
        bonus: await stakesTableRowElement.$eval(':nth-child(5)', node => node.innerText),
        potentialWinnings: await stakesTableRowElement.$eval(':nth-child(6)', node => node.innerText),
        winnings: await stakesTableRowElement.$eval(':nth-child(7)', node => node.innerText),
        status: await stakesTableRowElement.$eval(':nth-child(8)', node => node.innerText),
        note: await stakesTableRowElement.$eval(':nth-child(9)', node => node.innerText),
    };

    return betSlipStakes;
};

module.exports.scrapeBetSlips = scrapeBetSlips;