/**
 * Debug chalk output to see if ANSI codes are being generated
 */

import chalk from 'chalk'

console.log('Chalk level:', chalk.level)

const text = 'function'
const colored = chalk.hex('#8be9fd')(text)

console.log('Original:', text)
console.log('Colored:', colored)
console.log('Contains ANSI:', colored.includes('\x1b['))
console.log('Length original:', text.length)
console.log('Length colored:', colored.length)
console.log('JSON:', JSON.stringify(colored))
