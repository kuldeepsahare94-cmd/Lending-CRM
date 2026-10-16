// Countries, states and India's cities for the Country → State → City dropdowns.
// The data (geo.json) is made from open lists: countries and states from
// country-region-data (MIT); India's districts from india-states-districts and
// indian-states-cities-list (ISC); India's towns and cities from GeoNames
// (CC BY 4.0, geonames.org) via all-the-cities (MIT).
const fs = require('fs');
const path = require('path');

let text = null;
let data = null;
const load = () => {
  if (!text) { text = fs.readFileSync(path.join(__dirname, 'geo.json'), 'utf8'); data = JSON.parse(text); }
  return data;
};
module.exports = {
  json: () => { load(); return text; },
  data: load,
};
