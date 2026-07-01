const cheerio = require('cheerio');
const fs = require('fs');

const html = fs.readFileSync('logs/facebook_final_wholesalingrealestateforbeginners.html', 'utf8');
const $ = cheerio.load(html);
$("[role='dialog'], [aria-modal='true']").remove();
$("[data-testid='login_dialog'], [data-testid='signup-dialog']").remove();

const articles = $("[role='article']");
const first = articles.first();
console.log(first.html());
