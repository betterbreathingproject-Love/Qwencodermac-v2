// Sample JavaScript fixture for AST search testing
'use strict';

const fs = require('fs');

function greet(name) {
  return `Hello, ${name}!`;
}

const add = (a, b) => a + b;

async function fetchData(url) {
  const response = await fetch(url);
  return response.json();
}

class Calculator {
  constructor(initial) {
    this.value = initial || 0;
  }

  add(n) {
    this.value += n;
    return this;
  }

  subtract(n) {
    this.value -= n;
    return this;
  }

  getResult() {
    return this.value;
  }
}

module.exports = { greet, add, fetchData, Calculator };
