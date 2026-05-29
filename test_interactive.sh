#!/data/data/com.termux/files/usr/bin/bash
# Test script to verify consolidation of the --interactive mode in both Node.js and Python CLIs.

echo "============================================="
echo "Testing Node.js chrome-control-cli REPL..."
echo "============================================="

# Create a commands input for Node REPL
node_output=$(echo -e "help\nget-url\nget-title\neval 10 + 20\nexit" | node chrome-control-cli -i --url-keyword testio 2>&1)

echo "$node_output"

if ! echo "$node_output" | grep -q "Entering Chrome Control Interactive REPL"; then
    echo "FAIL: Node.js CLI did not display REPL welcome message."
    exit 1
fi

if ! echo "$node_output" | grep -q "Available commands"; then
    echo "FAIL: Node.js CLI 'help' command did not work."
    exit 1
fi

if ! echo "$node_output" | grep -q "30"; then
    echo "FAIL: Node.js CLI 'eval' command did not work."
    exit 1
fi

echo "SUCCESS: Node.js chrome-control-cli REPL verified successfully!"

echo ""
echo "============================================="
echo "Testing Python chrome_cli.py REPL..."
echo "============================================="

# Create a commands input for Python REPL
python_output=$(echo -e "help\nget-url\nget-title\neval 10 + 20\nexit" | python3 chrome_cli.py -i --url-keyword testio 2>&1)

echo "$python_output"

if ! echo "$python_output" | grep -q "Entering Chrome Control Interactive REPL"; then
    echo "FAIL: Python CLI did not display REPL welcome message."
    exit 1
fi

if ! echo "$python_output" | grep -q "Available commands"; then
    echo "FAIL: Python CLI 'help' command did not work."
    exit 1
fi

if ! echo "$python_output" | grep -q "30"; then
    echo "FAIL: Python CLI 'eval' command did not work."
    exit 1
fi

echo "SUCCESS: Python chrome_cli.py REPL verified successfully!"

echo ""
echo "All interactive tests passed successfully!"
exit 0
