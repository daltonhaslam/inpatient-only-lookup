// Facts about the site itself, used by the build and the browser.
export const SITE = {
  name: 'Inpatient Only Lookup',
  url: 'https://inpatient-only-lookup.vercel.app',
  repo: 'https://github.com/daltonhaslam/inpatient-only-lookup',
  author: 'Dalton Haslam, MD, MBA',
  linkedin: 'https://www.linkedin.com/in/dalton-haslam',
  family: 'https://paidandpenalized.org',
};

// Reader feedback: a shared Google Form with the site and page prefilled (both visible to the reader).
const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSekdB41siZs44_4gLNBGD2OqalK2TGNk7o8Q0bHl20ggYBy_Q/viewform';
export const feedbackHref = (path) =>
  `${FORM}?entry.2047320042=${encodeURIComponent(SITE.name)}&entry.1326474028=${encodeURIComponent(SITE.url + path)}`;

// Revenue-at-stake coder review: three Google Forms that share entry IDs (Paid-And-Penalized-Planning
// docs/review-forms.md). Readers see the prefilled answers. "Mapping reviewed" must start with the
// 8-hex fingerprint and a space: the review ingest reads that first word.
const REVIEW_FORMS = {
  agree: 'https://docs.google.com/forms/d/e/1FAIpQLSeEJHmFiIgKCQpxAtYWIqdNLsJcSF_nu-qbysv7T-44QMCnHA/viewform',
  wrong: 'https://docs.google.com/forms/d/e/1FAIpQLSdd6KDPlWCrsU-wz1VhJ3EdidND4jlWck6MIb72-Dyz8euWQg/viewform',
  claim: 'https://docs.google.com/forms/d/e/1FAIpQLSde05ihHrsmy3W4qry2gqvxAbLdKqCpFUWwrXAX0wsFaYMmsg/viewform',
};
export const REVIEW_ENTRY = { code: 'entry.53591076', mapping: 'entry.1873233910' };
const MAPPING_MAX = 200;
const mappingValue = (fp, summary) => `${fp} ${summary}`.slice(0, MAPPING_MAX);
const reviewHref = (form, code, fp, summary) =>
  `${REVIEW_FORMS[form]}?usp=pp_url&${REVIEW_ENTRY.code}=${encodeURIComponent(code)}&${REVIEW_ENTRY.mapping}=${encodeURIComponent(mappingValue(fp, summary))}`;
export const agreeHref = (code, fp, summary) => reviewHref('agree', code, fp, summary);
export const wrongHref = (code, fp, summary) => reviewHref('wrong', code, fp, summary);
export const claimHref = (batchId) => `${REVIEW_FORMS.claim}?usp=pp_url&${REVIEW_ENTRY.code}=${encodeURIComponent(batchId)}`;

// CMS's status indicators, in this site's words (CY 2027 OPPS final rule, Addendum D1).
export const STATUS = {
  C: 'inpatient procedure, not paid under the outpatient system',
  J1: 'paid as an outpatient service through a comprehensive APC',
  N: 'no separate outpatient payment; packaged into the payment for other services',
  T: 'paid as an outpatient service; the multiple-procedure reduction applies',
  S: 'paid as an outpatient service; not reduced when multiple',
  Q1: 'outpatient service, packaged when billed with certain other services and otherwise paid separately',
  Q2: 'outpatient service, packaged when billed with certain procedures and otherwise paid separately',
  E1: 'not paid by Medicare on outpatient claims',
  D: 'discontinued code',
};

export const CFR = {
  '412.3': 'https://www.ecfr.gov/current/title-42/section-412.3',
  '419.22': 'https://www.ecfr.gov/current/title-42/section-419.22',
};
