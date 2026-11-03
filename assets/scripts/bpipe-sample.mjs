// Sample Bloomberg B-PIPE usage, shared by the seed generator and the prototype.
// Invented users and tickers. Some rows deliberately use odd spacing or case
// to show ticker normalisation.
export const BPIPE_USAGE = [
  // login, user name, cost centre, email, security, exchange code
  ['sbrig', 'Schultz Brigitte', 'EQD', 'brigitte.schultz@northgate-demo.example', 'NGB2 PW Equity', 'PW'],
  ['sbrig', 'Schultz Brigitte', 'EQD', 'brigitte.schultz@northgate-demo.example', 'NGB5 PW Equity', 'PW'],
  ['sbrig', 'Schultz Brigitte', 'EQD', 'brigitte.schultz@northgate-demo.example', 'NGQ3 PW Equity', 'PW'],
  ['sbrig', 'Schultz Brigitte', 'EQD', 'brigitte.schultz@northgate-demo.example', 'WIG20 Index', 'PW'],
  ['vmarc', 'Vidal Marco', 'CMD', 'marco.vidal@northgate-demo.example', 'ngb7  pw equity', 'PW'],
  ['vmarc', 'Vidal Marco', 'CMD', 'marco.vidal@northgate-demo.example', 'CO1 Comdty', 'ICE'],
  ['vmarc', 'Vidal Marco', 'CMD', 'marco.vidal@northgate-demo.example', 'TTFG1MON Index', 'ICE'],
  ['nkaur', 'Kaur Nisha', 'RSK', 'nisha.kaur@northgate-demo.example', 'NGB11 PW Equity', 'PW'],
  ['nkaur', 'Kaur Nisha', 'RSK', 'nisha.kaur@northgate-demo.example', 'SX5E Index', 'EUX'],
  ['bpipe_eqd_pricer_prd', 'EQD Pricer PRD', 'EQD', 'support@northgate-demo.example', 'NGB2 PW Equity', 'PW'],
  ['bpipe_eqd_pricer_prd', 'EQD Pricer PRD', 'EQD', 'support@northgate-demo.example', 'NGB5 PW Equity', 'PW'],
  ['bpipe_eqd_pricer_prd', 'EQD Pricer PRD', 'EQD', 'support@northgate-demo.example', 'NGB11 PW Equity', 'PW'],
  ['bpipe_eqd_pricer_prd', 'EQD Pricer PRD', 'EQD', 'support@northgate-demo.example', 'NGQ8 PW Equity', 'PW'],
  ['bpipe_eqd_pricer_prd', 'EQD Pricer PRD', 'EQD', 'support@northgate-demo.example', 'WIG20 Index', 'PW'],
];
export const BPIPE_APPS = {
  bpipe_eqd_pricer_prd: { name: 'EQD pricer (production)', owner: 'Equity Derivatives Technology', email: 'eqd-tech@northgate-demo.example' },
};

// CSV in the column layout the B-PIPE parser expects, for testing uploads
export function bpipeCsv() {
  const head = 'User ID,User Name,Cost Centre,Email,Security,Exchange Code';
  return [head, ...BPIPE_USAGE.map(r => r.map(v => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))].join('\r\n') + '\r\n';
}
