import { checkTests } from './_lib.mjs';
checkTests({ testFile: 'test/calc.test.js', srcFile: 'src/calc.js', minTests: 3, mutants: [["a + b","a - b"],["a / b","a * b"]] });
