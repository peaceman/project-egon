const path = require('path');
const fs = require('fs-extra');
const { URL } = require('url');
const { config } = require('./config.js');
const { login, waitForBlockingOverlay, genUserFolder } = require('./util.js');

const scrapeUserList = async (browser, config) => {
    const page = await browser.newPage();

    try {
        await login(page);
        await navigateToPlayersList(page);
        await sortPlayersListById(page);

        await page.select('select[name=tblPlayers_length]', '100');
        await waitForBlockingOverlay(page);
    } catch (e) {
        console.log('catched', e);
        process.exit();
    }

    const nextButtonSelector = '#tblPlayers_next';

    while (true) {
        // scrape user links
        const userLinks = await page.$$eval('#tblPlayers tbody > tr > :nth-child(3) > a', anchors => anchors.map(a => a.href));
        console.log(`Found ${userLinks.length} user links`);

        for (const userLink of userLinks) {
            const userURL = new URL(userLink);
            const userID = userURL.searchParams.get('id');
            const targetFolder = genUserFolder(userID);
            const dataJSONPath = `${targetFolder}/data.json`;
            const failedPath = `${targetFolder}/failed`;
            const triesJSONPath = `${targetFolder}/tries.json`;

            await fs.ensureDir(targetFolder);

            if (await fs.pathExists(dataJSONPath) || await fs.pathExists(failedPath)) {
                console.log('Skipping user', userID);
                continue;
            }

            let tries = (await fs.pathExists(triesJSONPath))
                ? await fs.readJSON(triesJSONPath)
                : 0;

            if (tries == 2) {
                await fs.ensureFile(failedPath);
                continue;
            }

            await fs.writeJSON(triesJSONPath, tries + 1);
            await scrapeUser(browser, targetFolder, userURL, userID);
        }

        // page
        if (await page.$(`${nextButtonSelector}.disabled`) != null) {
            console.info('Reached last page');
            break;
        }

        await page.click(nextButtonSelector);
        await page.waitForSelector('body > div.blockUI.blockOverlay', {hidden: true});
    }
};

const navigateToPlayersList = async page => {
    await page.goto(`${config.baseUrl}/${config.segmentUrl}`);

    // await page.click('body > div.page-container > div.page-sidebar.nav-collapse.collapse > ul > li:nth-child(3) > a');
    // const navigationPromise = page.waitForNavigation();
    // await page.click('#accPlayer_index_player > a');
    // await navigationPromise;

    await page.waitForSelector('#tblPlayers > tbody > tr:nth-child(1)');
};

const sortPlayersListById = async page => {
    await page.click('#tblPlayers > thead > tr > th:nth-child(1)');
    await waitForBlockingOverlay(page);

    if (process.argv[2] == 'desc') {
        console.log('desc player sort');
        await page.click('#tblPlayers > thead > tr > th:nth-child(1)');
        await waitForBlockingOverlay(page);
    }
};

const scrapeUser = async (browser, targetFolder, userURL, userID) => {
    console.log('Begin scraping user', {id: userID});

    const userPage = await browser.newPage();
    userPage.setDefaultNavigationTimeout(5 * 60 * 1000);

    try {    
        console.log('Navigating to ' + userURL);
        const userNotesResponsePromise = userPage.waitForResponse(response => {
            console.log('waiting for user notes response', response.url());
            return response.url().includes('Notes/GetUserNotesData')
        });
        await userPage.goto(userURL);
        
        const dataJSONPath = `${targetFolder}/data.json`;

        const userNotesResponse = await userNotesResponsePromise;

        const result = {
            id: userID,
            balance: await userPage.evaluate(scrapeUserBalanceInContext),
            profile: await scrapeUserProfile(userPage),
            kycDocuments: await scrapeKYCDocuments(userPage, targetFolder),
            userNotes: ((await userNotesResponse.json()) || {}).data,
            vipStatus: await userPage.evaluate(() => Number(document.querySelector('#playerRating').dataset.score)),
            responsibleGaming: await scrapeResponsibleGaming(userPage),
            bonuses: {
                applicable: await scrapeApplicableBonuses(userPage),
                current: await scrapeCurrentBonuses(userPage),
            },
            securityLogs: await scrapeSecurityLogs(userPage),
        };

        await scrapeTransactions(userPage, targetFolder);

        console.log('scrapeUser', result);

        fs.writeJson(dataJSONPath, result, {spaces: 2});
    } finally {
        await userPage.close();
    }
};

const scrapeUserBalanceInContext = () => {
    const tryToFetchFromElement = id => {
        return (document.getElementById(id) || {}).innerText;
    };

    const data = {
        balance: tryToFetchFromElement('lblPlayerBalance'),
        real: tryToFetchFromElement('lblPlayerRealBalance'),
        bonus: tryToFetchFromElement('lblPlayerBonusBalance'),
    };

    return data;
};

const scrapeTransactions = async (userPage, targetFolder) => {
    console.log('Scraping transactions', {url: userPage.url()})
    await userPage.waitForSelector('body > div.blockUI.blockOverlay', {hidden: true});

    const loadedTransactions = userPage.waitForResponse(response => response.url().includes('Transaction/GetAllDepositsTransaction'));
    await userPage.click('body > div.page-container > div.page-content > div > div.row-new.clearfix.player-header > div.player-name-money.row-fluid > div.span8 > nav > div.pull-right > ul > li:nth-child(4) > div > div > button');
    await userPage.waitFor(250);
    await userPage.click('#tab3linq');

    await loadedTransactions;

    await userPage.evaluate(() => {
        document.querySelector('#tbFrom').value = '2000/01/01 00:00';
        document.querySelector('#tbTo').value = '2030/01/01 00:00';
    });
    await userPage.click('#btnFilter');

    await waitForBlockingOverlay(userPage);

    const downloadButtonSelector = '#ToolTables_tblTransactionsApproval_2';
    await userPage.waitForSelector(downloadButtonSelector);

    const downloadFolder = targetFolder;
    console.log('DownloadFolder', downloadFolder);
    await userPage._client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: downloadFolder});

    const downloadResponsePromise = userPage.waitForResponse(response => {
        console.debug('response url', response.url());
        return response.url().includes('CSVExportAllTransactions');
    });
    await userPage.click(downloadButtonSelector);

    console.log('Waiting for download response');
    await downloadResponsePromise;
};

const scrapeUserProfile = async (userPage) => {
    console.log('Scraping user profile', {url: userPage.url()});

    await userPage.click('#tab111linq');
    await userPage.waitForResponse(response => {
        console.debug('waiting for account info', response.url());
        return response.url().includes('AccountInfo');
    });
    await userPage.waitForSelector('body > div.blockUI.blockOverlay', {hidden: true});
    await userPage.waitForSelector('#Username');

    return await userPage.evaluate(() => {
        const inputs = [...document.querySelectorAll('input')]
            .filter(el => el.type !== 'hidden')
            .map(input=>({
                name: input.name,
                value: input.type !== 'checkbox' ? input.value : input.checked
            }))
            .filter(entry => Boolean(entry.name));

        const selects = [...document.querySelectorAll('select')]
            .map(el => ({
                name: el.name || el.id, 
                value: (el.options[el.selectedIndex] || {}).innerHTML
            }))
            .filter(entry => Boolean(entry.name));

        return [...inputs, ...selects];
    });
};

const scrapeKYCDocuments = async (userPage, targetFolder) => {
    console.log('Scraping kyc documents', {url: userPage.url()});
    await userPage.waitForSelector('body > div.blockUI.blockOverlay', {hidden: true});

    console.log('waiting for #liRestrictions > button');
    await userPage.waitForSelector('#liRestrictions > button');

    const loaderVisible = userPage.waitForSelector('#tblKYCDocuments_processing', {visible: true});
    console.log('click #liRestrictions > button');
    await userPage.click('#liRestrictions > button');

    console.log('click kyc');
    await userPage.click('#tab7linq');

    console.log('waiting for the visible kyc processing loader');
    await loaderVisible;

    console.log('waiting for the hidden kyc processing loader');
    await userPage.waitForSelector('#tblKYCDocuments_processing', {hidden: true});

    const downloadButtonSelector = 'td.actionsWidth > a.btn.blue.mini:nth-child(1)';
    const downloadButtonElements = await userPage.$$(downloadButtonSelector);
    console.log(`found ${downloadButtonElements.length} download buttons`);

    await userPage.waitFor(500);

    await userPage._client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: targetFolder});

    for (const dbe of downloadButtonElements) {
        try {
            const downloadPromise = userPage.waitForResponse(response => {
                const resURL = response.url();
                console.debug('wait for kyc document / response url', resURL);
                const validURLs = ['GetFile?userIdentificationDocumentId', 'Error'];
    
                return !validURLs.every(url => !resURL.includes(url));
            });
    
            console.log('clicking on a kyc document download button');
            await dbe.click();
            console.log('waiting for the kyc document download');
            const downloadResponse = await downloadPromise;
        } catch (e) {
            console.log('error while downloading', e);
        }
    }

    return await userPage.evaluate(() => {
        const inputs = [...document.querySelectorAll('#tblKYCDocuments tbody > tr')]
            .filter(row => row.childElementCount > 1)
            .map(row => ({
                filename: row.querySelector(':nth-child(1').innerText, 
                created: row.querySelector(':nth-child(8)').innerText, 
                status: row.querySelector(':nth-child(13)').innerText,
            }));

        return inputs;
    })
};

const scrapeResponsibleGaming = async (userPage) => {
    console.log('Scraping responsible gaming');
    console.log('waiting for #liRestrictions > button');
    await userPage.waitForSelector('#liRestrictions > button');

    console.log('click #liRestrictions > button');
    await userPage.click('#liRestrictions > button');

    console.log('click responsible gaming');
    await userPage.click('#tab8linq');

    await waitForBlockingOverlay(userPage);

    const results = {};

    const exclusionResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for exclusion response', response.url());
        return response.url().includes('Player/GetUserLimitsTableByType?type=exclusion');
    });
    console.log('clicking on exclusion');
    await userPage.waitForSelector('#tabExclusion > div.accordion-heading > span');
    await userPage.click('#tabExclusion > div.accordion-heading > span');
    results.exclusion = (await (await exclusionResponsePromise).json() || {}).aaData;

    await waitForBlockingOverlay(userPage);
    const transactionResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for transaction response', response.url());
        return response.url().includes('Player/GetUserLimitsTableByType?type=transaction');
    });
    console.log('clicking on transaction');
    await userPage.waitForSelector('#tabTransaction > div.accordion-heading > span');
    await userPage.click('#tabTransaction > div.accordion-heading > span');
    results.transaction = (await (await transactionResponsePromise).json() || {}).aaData;

    await waitForBlockingOverlay(userPage);
    const wageringResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the wagering response', response.url());
        return response.url().includes('Player/GetUserLimitsTableByType?type=wagering');
    });
    console.log('clicking on wagering');
    await userPage.waitForSelector('#tabWagering > div.accordion-heading > span');
    await userPage.click('#tabWagering > div.accordion-heading > span');
    results.wagering = (await (await wageringResponsePromise).json() || {}).aaData;

    await waitForBlockingOverlay(userPage);
    const netlossResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the netloss response', response.url());
        return response.url().includes('Player/GetUserLimitsTableByType?type=netloss');
    });
    console.log('clicking on netloss');
    await userPage.waitForSelector('#tabNetLoss > div.accordion-heading > span');
    await userPage.click('#tabNetLoss > div.accordion-heading > span');
    results.netloss = (await (await netlossResponsePromise).json() || {}).aaData;

    await waitForBlockingOverlay(userPage);
    const timeResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the time response', response.url());
        return response.url().includes('Player/GetUserLimitsTableByType?type=time');
    });
    console.log('clicking on time');
    await userPage.waitForSelector('#tabTime > div.accordion-heading > span');
    await userPage.click('#tabTime > div.accordion-heading > span');
    results.time = (await (await timeResponsePromise).json() || {}).aaData;

    await waitForBlockingOverlay(userPage);
    return results;
};

const scrapeApplicableBonuses = async userPage => {
    await waitForBlockingOverlay(userPage);

    console.log('click bonuses');
    await userPage.click('body > div.page-container > div.page-content > div > div.row-new.clearfix.player-header > div.player-name-money.row-fluid > div.span8 > nav > div.pull-right > ul > li:nth-child(9) > button');

    const applicableBonusesResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the applicable bonuses response', response.url());
        return response.url().includes('Player/GetApplicableUserBonuses');
    });

    console.log('click applicable');
    await userPage.click('#tab14linq');

    const applicableBonusesResponse = await applicableBonusesResponsePromise;

    return ((await applicableBonusesResponse.json()) || {}).aaData;
};

const scrapeCurrentBonuses = async userPage => {
    await waitForBlockingOverlay(userPage);

    console.log('click bonuses');
    await userPage.click('body > div.page-container > div.page-content > div > div.row-new.clearfix.player-header > div.player-name-money.row-fluid > div.span8 > nav > div.pull-right > ul > li:nth-child(9) > button');

    console.log('click current');
    await userPage.click('#tab13linq');
    await waitForBlockingOverlay(userPage);

    const bonusesResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the bonuses response', response.url());
        return response.url().includes('Player/GetUserBonuses');
    });

    console.log('select 100 entries');
    await userPage.select('select[name=tblUserBonuses_length]', '100');

    const bonusesResponse = await bonusesResponsePromise;

    return ((await bonusesResponse.json()) || {}).aaData;
};

const scrapeSecurityLogs = async userPage => {
    const securityLogsResponsePromise = userPage.waitForResponse(response => {
        console.log('waiting for the security logs response');
        return response.url().includes('Player/UserSecurityLogsData');
    });

    await userPage.evaluate(() => {
        const queryString = 'sEcho=1&iColumns=8&sColumns=ID%2CType%2CIPAddress%2CDate%2CCountry%2CLoginAttemptResult%2CLoginAttemptReason%2CEnteredUsername&iDisplayStart=0&iDisplayLength=10&mDataProp_0=ID&bSortable_0=false&mDataProp_1=Type&bSortable_1=true&mDataProp_2=IPAddress&bSortable_2=true&mDataProp_3=Date&bSortable_3=true&mDataProp_4=Country&bSortable_4=false&mDataProp_5=LoginAttemptResult&bSortable_5=true&mDataProp_6=LoginAttemptReason&bSortable_6=true&mDataProp_7=EnteredUsername&bSortable_7=true&iSortCol_0=1&sSortDir_0=desc&iSortingCols=1';
        const searchParams = new URLSearchParams(queryString);

        searchParams.set('iDisplayLength', 9999);

        fetch("/Player/UserSecurityLogsData", {
            "credentials": "include",
            "headers": {
                "Accept": "application/json", 
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
            },
            "referrerPolicy": "no-referrer-when-downgrade",
            "body": searchParams.toString(),
            "method": "POST",
            "mode": "cors",
        });
    });

    const securityLogsResponse = await securityLogsResponsePromise;

    return ((await securityLogsResponse.json()) || {}).aaData;
};

module.exports.scrapeUserList = scrapeUserList;