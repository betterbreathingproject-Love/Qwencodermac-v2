# Sample Python fixture for AST search testing

import os
from pathlib import Path

def greet(name):
    return f"Hello, {name}!"

def add(a, b):
    return a + b

async def fetch_data(url):
    pass

class Calculator:
    def __init__(self, initial=0):
        self.value = initial

    def add(self, n):
        self.value += n
        return self

    def subtract(self, n):
        self.value -= n
        return self

    def get_result(self):
        return self.value
