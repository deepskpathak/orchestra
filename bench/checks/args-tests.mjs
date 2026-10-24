import { checkTests } from './_lib.mjs';
checkTests({ testFile: 'test/args.test.js', srcFile: 'src/args.js', minTests: 4, mutants: [["flags[a.slice(2)] = true","flags[a.slice(2)] = false"],["a.slice(eq + 1)","a.slice(eq)"],["positional.push(a)","positional.push(a + \"!\")"],["flags[a.slice(1)] = true","flags[a.slice(1)] = false"]] });
