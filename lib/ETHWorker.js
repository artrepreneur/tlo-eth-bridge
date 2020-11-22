var base58 = require('base58-native');
var fs = require('fs');
var Web3 = require('web3');
require('./logger.js');
var apiInterfaces = require('./apiInterfaces.js')(global.config.talleo.daemon, global.config.talleo.wallet);
require('./configReader.js');
var logEthereum = 'ethereum';
require('./exceptionWriter.js')(logEthereum);

var log = function (severity, system, text, data) {
    "use strict";
    global.log(severity, system, text, data);
};

var lastBlockFound;

var etherTransfers = {};

function fromHexString(hex){
    hex = hex.toString();
    var bytes = new Uint8Array(hex.length / 2);
    for(var i=0; i< hex.length-1; i+=2) {
        var c = parseInt(hex.substr(i, 2), 16);
        if (c > 127) {
          c = c - 256;
        }
        bytes[i/2] = c;
    }
    return bytes;
}

async function getConfirmations(txHash) {
    "use strict";
    try {
        // Instantiate web3 with HttpProvider
        var web3 = new Web3(global.config.ethereum.httpsNode);

        // Get transaction details
        var trx = await web3.eth.getTransaction(txHash);

        // Get current block number
        var currentBlock = await web3.eth.getBlockNumber();

        // When transaction is unconfirmed, its block number is null.
        // In this case we return 0 as number of confirmations
        return trx.blockNumber === null ? 0 : currentBlock - trx.blockNumber;
    } catch (error) {
        log('error', logEthereum, 'Error "%s" while trying to get number of confirmations for transaction with hash "%S"', [error, txHash]);
    }
}

function confirmEtherTransaction(txHash) {
    "use strict";
    setTimeout(async function () {

        // Get current number of confirmations and compare it with sought-for value
        var txConfirmations = await getConfirmations(txHash);
        var etherTransfer = etherTransfers[txHash].returnValues;
        var TLOAddress = base58.encode(fromHexString(etherTransfer.to.substr(2)));

        log('info', logEthereum, 'Transaction with hash %s has %d confirmation(s)', [txHash, txConfirmations]);

        if (txConfirmations >= (global.config.ethereum.confirmations || 10)) {
            // Handle confirmation event according to your business logic

            log('info', logEthereum, 'Transaction with hash %s has been successfully confirmed', [txHash]);

            global.redisClient.hget('ethereum', 'conversion' + txHash, function (err, result) {
                // Check that we haven't processed this conversion request already, minimum amount is 1 TLO
                if (result === null && etherTransfer.value > 100) {
                    var fee = (global.config.talleo.fee || 1);
                    var transferRPC = {
                            'transfers': [
                                {
                                    'amount': etherTransfer.value - fee,
                                    'address' : TLOAddress
                                }
                            ],
                            'fee': fee,
                            'anonymity': 3,
                        };
                    apiInterfaces.rpcWallet('sendTransaction', transferRPC, function (err1, response1) {
                        var amount = ((etherTransfer.value - transferRPC.fee) / 100);
                        var feeAmount = transferRPC.fee / 100;
                        if (err1) {
                            if (err1.message == 'Bad address') {
                                log('error', logEthereum, 'Invalid address "%s" while sending conversion request from %s', [TLOAddress, etherTransfer._from]);
                                return;
                            }
                            log('error', logEthereum, 'Error "%s" while sending conversion request from %s to %s with amount %s and fee %s', [err1.message, etherTransfer._from, TLOAddress, amount.toFixed(2), feeAmount.toFixed(2)]);
                            return confirmEtherTransaction(txHash);
                        }
                        var TLOHash = response1.transactionHash;
                        if (TLOHash) {
                            log('info', logEthereum, 'Conversion completed from %s to %s for %s TLO, with fee %s TLO and transaction hash "%s"', [etherTransfer.from, TLOAddress, amount.toFixed(2), feeAmount.toFixed(2), TLOHash]);
                            global.redisClient.hset('ethereum', 'conversion' + txHash, TLOHash, function (err2) {
                                if (err2) {
                                    log('error', logEthereum, 'Error "%s" while storing conversion from %s to %s with amount %s', [err2, etherTransfer.from, TLOAddress, amount.toFixed(2)]);
                                }
                            });
                        } else {
                            log('error', logEthereum, 'Unexpected response "%s" while sending conversion request from %s to %s with amount %s and fee %s', [JSON.stringify(response1), etherTransfer._from, TLOAddress, amount.toFixed(2), feeAmount.toFixed(2)]);
                            return confirmEtherTransaction(txHash);
                        }
                    });
                }
            });
            return;
        }
        // Recursive call
        return confirmEtherTransaction(txHash);
    }, 30 * 1000);
}

(function init() {
    "use strict";
    global.redisClient.hget('ethereum', 'lastBlockFound', function (error, result) {
        if (error) {
            lastBlockFound = 0;
        } else {
            lastBlockFound = parseInt(result);
        }
        var web3 = new Web3(new Web3.providers.WebsocketProvider(global.config.ethereum.wssNode));

        fs.readFile(global.config.ethereum.contractABI, { encoding: 'utf-8' }, function (error1, data) {
            if (error1) {
                log('error', logEthereum, 'Error while trying to read contract file "%s"', [global.config.ethereum.contractABI]);
                process.exit(1);
                //return;
            }
            var tokenContract = new web3.eth.Contract(
                JSON.parse(data),
                global.config.ethereum.contractAddress);

            var options = {
                fromBlock: (lastBlockFound === 0) ? (global.config.ethereum.startHeight || 0) : lastBlockFound + 1
            };
            log('info', logEthereum, 'Scanning from %d...', [options.fromBlock]);


            tokenContract.events.ConversionTo(options, function (error2, event) {
               if (error2) {
                   log('error', logEthereum, 'Error "%s" while trying to subscribe to "ConversionTo" event', [error2]);
                   return;
               }

               var ETHAddress = event.returnValues.from;
               var TLOAddress = base58.encode(fromHexString(event.returnValues.to.substr(2)));
               var amount = event.returnValues.value / 100;
               log('info', logEthereum, 'Conversion request from %s to %s for %s TLO', [ETHAddress, TLOAddress, amount.toFixed(2)]);
               if (event.blockNumber && event.blockNumber > lastBlockFound) {
                   global.redisClient.hset('ethereum', 'lastBlockFound', event.blockNumber, function (error3) {
                       if (error3) {
                           log('error', logEthereum, 'Error "%s" updating last block found from %d to %d', [error3, lastBlockFound, event.blockNumber]);
                       }
                       lastBlockFound = event.blockNumber;
                   });
               }
               etherTransfers[event.transactionHash] = event;
               confirmEtherTransaction(event.transactionHash);
           });
        });
    });
}());