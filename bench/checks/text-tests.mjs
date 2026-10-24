import { checkTests } from './_lib.mjs';
checkTests({ testFile: 'test/text.test.js', srcFile: 'src/text.js', minTests: 3, mutants: [[".toUpperCase()",".toLowerCase()"],["s.slice(1)","s.slice(2)"],["s.charAt(0).toUpperCase() + ",""]] });
