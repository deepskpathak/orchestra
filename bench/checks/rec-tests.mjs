import { checkTests } from './_lib.mjs';
checkTests({ testFile: 'test/records.test.js', srcFile: 'src/records.js', minTests: 5, mutants: [["(out[k] ||= []).push(it)","(out[k] ||= []).unshift(it)"],["a[key] < b[key] ? -1","a[key] > b[key] ? -1"],["i += size","i += size + 1"],["const k = keyFn(it);","const k = 0;"]] });
