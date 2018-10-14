#!/usr/bin/env node

const program = require('commander');
const { config } = require('./config.js');
const { callWithBrowser } = require('./util.js');
const { scrapeUserList } = require('./scrape-user-list.js');
const { scrapeBetSlips } = require('./scrape-bet-slips.js');

program
    .command('scrape-user-list')
    .option('--order <order>', 'user list sort order', /^(asc|desc)$/, 'asc')
    .action(async options => {
        await callWithBrowser(browser => scrapeUserList(browser, config));
    });

program
    .command('scrape-bet-slips')
    .option('--order <order>', 'bet slip sort order', /^(asc|desc)$/, 'asc')
    .action(async options => {
        await callWithBrowser(browser => scrapeBetSlips(browser, options, config));
    });

program.parse(process.argv);

