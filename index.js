#!/usr/bin/env node

import { ethers } from 'ethers';
import { Command } from 'commander';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import csv from 'csv-parser';
import dotenv from 'dotenv';
import chalk from 'chalk';
import Table from 'cli-table3';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载环境变量
dotenv.config();

// ERC20代币ABI
const ERC20_ABI = [
  // 只包含我们需要的函数
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// 配置
const config = {
  network: process.env.NETWORK || 'ethereum',
  rpcUrl: process.env.ETHEREUM_RPC_URL,
  logLevel: process.env.LOG_LEVEL || 'info'
};

// 根据选择的网络设置RPC URL
config.rpcUrl = process.env[`${config.network?.toUpperCase()}_RPC_URL`]

// 命令行参数解析
const program = new Command();

program
  .name('address-checker')
  .description('检查区块链地址对特定代币的授权情况')
  .version('1.0.0')
  .option('-a, --address <address>', '单个钱包地址')
  .option('-af, --address-file <path>', '包含钱包地址的文件路径（每行一个地址）')
  .option('-t, --token <address>', '单个代币合约地址')
  .option('-tf, --token-file <path>', '包含代币合约地址的文件路径（每行一个地址）')
  .option('-s, --spender <address>', '单个授权接收者(spender)合约地址')
  .option('-sf, --spender-file <path>', '包含授权接收者合约地址的文件路径（每行一个地址）')
  .option('-e, --export <path>', '导出结果到CSV文件')
  .option('-v, --verbose', '显示详细日志')
  .allowUnknownOption(true); // 允许未知选项，例如--

// 处理参数
const processedArgs = process.argv.filter(arg => arg !== '--');
program.parse(processedArgs);

const options = program.opts();

// 日志函数
const logger = {
  debug: (...args) => {
    if (options.verbose || config.logLevel === 'debug') {
      console.log(chalk.gray('[DEBUG]'), ...args);
    }
  },
  info: (...args) => {
    if (['debug', 'info'].includes(config.logLevel)) {
      console.log(chalk.blue('[INFO]'), ...args);
    }
  },
  warn: (...args) => {
    if (['debug', 'info', 'warn'].includes(config.logLevel)) {
      console.log(chalk.yellow('[WARN]'), ...args);
    }
  },
  error: (...args) => {
    console.error(chalk.red('[ERROR]'), ...args);
  }
};

// 主函数
async function main() {
  try {
    // 验证必要参数
    if (!options.address && !options.addressFile) {
      logger.error('必须提供钱包地址或地址文件');
      process.exit(1);
    }

    if (!options.token && !options.tokenFile) {
      logger.error('必须提供代币地址或代币地址文件');
      process.exit(1);
    }

    // 验证RPC URL
    if (!config.rpcUrl) {
      logger.error(`未找到${config.network}网络的RPC URL，请在.env文件中配置`);
      process.exit(1);
    }

    // 连接到区块链网络
    logger.info(`连接到${config.network}网络...`);
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    // 网络检查
    const network = await provider.getNetwork();
    logger.info(`已连接到网络: ${network.name} (chainId: ${network.chainId})`);

    // 读取地址
    const addresses = await getAddresses();
    logger.info(`已加载${addresses.length}个钱包地址`);

    // 读取代币
    const tokens = await getTokens();
    logger.info(`已加载${tokens.length}个代币地址`);

    // 读取spender合约
    const spenders = await getSpenders();
    logger.info(`已加载${spenders.length}个spender合约地址`);

    // 检查授权
    logger.info('开始检查授权...');
    const results = await checkApprovals(provider, addresses, tokens, spenders);

    // 显示结果
    displayResults(results);

    // 导出结果
    if (options.export) {
      await exportResults(results, options.export);
      logger.info(`结果已导出到 ${options.export}`);
    }

  } catch (error) {
    logger.error('程序执行出错:', error);
    process.exit(1);
  }
}

// 读取地址列表
async function getAddresses() {
  if (options.address) {
    return [options.address];
  } else if (options.addressFile) {
    return readLinesFromFile(options.addressFile);
  }
  return [];
}

// 读取代币列表
async function getTokens() {
  if (options.token) {
    return [{ address: options.token, price: null }];
  } else if (options.tokenFile) {
    return readTokensFromFile(options.tokenFile);
  }
  return [];
}

// 从文件读取代币信息，包括价格
async function readTokensFromFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const parts = line.split(',');
        // 检查是否有价格信息
        if (parts.length > 1) {
          return {
            address: parts[0].trim(),
            price: parseFloat(parts[1].trim())
          };
        } else {
          return {
            address: parts[0].trim(),
            price: null
          };
        }
      });
  } catch (error) {
    logger.error(`读取文件 ${filePath} 出错:`, error);
    process.exit(1);
  }
}

// 读取spender列表
async function getSpenders() {
  if (options.spender) {
    return [options.spender];
  } else if (options.spenderFile) {
    return readLinesFromFile(options.spenderFile);
  }
  // 如果未指定spender，返回一个空数组
  return [];
}

// 从文件读取行
async function readLinesFromFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    logger.error(`读取文件 ${filePath} 出错:`, error);
    process.exit(1);
  }
}

// 检查授权
async function checkApprovals(provider, addresses, tokens, spenders) {
  const results = [];

  // 如果未指定spender，则设置为空数组表示我们将查询所有已知的授权
  // 在实际实现中，我们需要另一种方式来获取所有spender，因为区块链上没有直接的方法获取所有授权
  // 这里简化处理，如果未指定spender，则报错
  if (spenders.length === 0) {
    logger.error('未指定spender合约地址。请使用 --spender 或 --spender-file 选项');
    process.exit(1);
  }

  for (const address of addresses) {
    logger.debug(`检查地址: ${address}`);
    
    for (const tokenInfo of tokens) {
      try {
        const tokenAddress = tokenInfo.address;
        logger.debug(`  检查代币: ${tokenAddress}`);
        
        // 创建代币合约实例
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        
        // 获取代币信息
        let symbol, decimals, price;
        try {
          [symbol, decimals] = await Promise.all([
            tokenContract.symbol(),
            tokenContract.decimals()
          ]);
          
          // 如果没有提供价格，尝试从符号推断
          if (tokenInfo.price === null) {
            // 假设USDT、USDC、DAI等稳定币价格为1
            if (['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDK', 'GUSD'].includes(symbol)) {
              price = 1;
            } else {
              price = null;
            }
          } else {
            price = tokenInfo.price;
          }
          
        } catch (error) {
          logger.warn(`无法获取代币 ${tokenAddress} 的信息:`, error.message);
          symbol = '未知';
          decimals = 18; // 默认值
          price = tokenInfo.price;
        }
        
        // 获取账户余额
        let balance = ethers.getBigInt(0);
        try {
          balance = await tokenContract.balanceOf(address);
          logger.debug(`  地址 ${address} 的 ${symbol} 余额: ${ethers.formatUnits(balance, decimals)}`);
        } catch (error) {
          logger.warn(`获取 ${address} 的 ${symbol} 余额出错:`, error.message);
        }
        
        for (const spender of spenders) {
          try {
            // 获取授权金额
            const allowance = await tokenContract.allowance(address, spender);
            
            // 检查是否是无限授权 (2^256 - 1)
            const maxUint256 = ethers.MaxUint256;
            const isInfiniteApproval = allowance.toString() === maxUint256.toString();
            
            // 格式化显示的金额
            const formattedAllowance = isInfiniteApproval 
              ? '∞' 
              : ethers.formatUnits(allowance, decimals);
            
            // 计算曝光量（授权金额与余额的较小值）
            let exposedAmount;
            if (isInfiniteApproval) {
              // 如果是无限授权，曝光量等于余额
              exposedAmount = balance;
            } else {
              // 否则，曝光量为授权金额与余额的较小值
              exposedAmount = allowance > balance ? balance : allowance;
            }
            
            // 格式化显示的曝光量
            const formattedExposedAmount = ethers.formatUnits(exposedAmount, decimals);
            
            // 计算曝光美元价值
            let exposedValueUSD = null;
            if (price !== null) {
              exposedValueUSD = parseFloat(formattedExposedAmount) * price;
            }
            
            // 添加到结果
            results.push({
              walletAddress: address,
              tokenAddress: tokenAddress,
              tokenSymbol: symbol,
              spenderAddress: spender,
              allowance: formattedAllowance,
              rawAllowance: allowance.toString(),
              isInfiniteApproval,
              balance: ethers.formatUnits(balance, decimals),
              rawBalance: balance.toString(),
              exposedAmount: formattedExposedAmount,
              rawExposedAmount: exposedAmount.toString(),
              price: price,
              exposedValueUSD: exposedValueUSD
            });
            
          } catch (error) {
            logger.warn(`检查 ${address} 对 ${tokenAddress} 授权给 ${spender} 出错:`, error.message);
          }
        }
      } catch (error) {
        logger.warn(`处理代币 ${tokenInfo.address} 出错:`, error.message);
      }
    }
  }

  return results;
}

// 显示结果
function displayResults(results) {
  if (results.length === 0) {
    logger.info('未找到任何授权信息');
    return;
  }

  // 创建表格
  const table = new Table({
    head: [
      chalk.white('钱包地址'), 
      chalk.white('代币'), 
      chalk.white('Spender合约'), 
      chalk.white('授权金额'), 
      chalk.white('余额'),
      chalk.white('曝光量'),
      chalk.white('曝光价值(USD)'),
      chalk.white('无限授权')
    ],
    colWidths: [16, 10, 16, 12, 12, 12, 16, 10]
  });

  // 填充表格数据
  for (const result of results) {
    const isInfinite = result.isInfiniteApproval
      ? chalk.red('是')
      : chalk.green('否');
    
    const allowance = result.isInfiniteApproval
      ? chalk.red(result.allowance)
      : parseFloat(result.allowance) > 0
        ? chalk.yellow(result.allowance)
        : chalk.green(result.allowance);
    
    const balance = chalk.cyan(result.balance);
    
    const exposedAmount = parseFloat(result.exposedAmount) > 0
      ? chalk.yellow(result.exposedAmount)
      : chalk.green(result.exposedAmount);
    
    const exposedValueUSD = result.exposedValueUSD !== null
      ? (parseFloat(result.exposedValueUSD) > 100
        ? chalk.red(`$${result.exposedValueUSD.toFixed(2)}`)
        : chalk.yellow(`$${result.exposedValueUSD.toFixed(2)}`))
      : chalk.gray('未知');
    
    table.push([
      shortenAddress(result.walletAddress),
      result.tokenSymbol,
      shortenAddress(result.spenderAddress),
      allowance,
      balance,
      exposedAmount,
      exposedValueUSD,
      isInfinite
    ]);
  }

  console.log(table.toString());
  
  // 总结
  const uniqueWallets = new Set(results.map(r => r.walletAddress)).size;
  const uniqueTokens = new Set(results.map(r => r.tokenAddress)).size;
  const infiniteApprovals = results.filter(r => r.isInfiniteApproval).length;
  
  // 计算总曝光价值
  let totalExposedValueUSD = 0;
  let exposedValueCount = 0;
  for (const result of results) {
    if (result.exposedValueUSD !== null) {
      totalExposedValueUSD += result.exposedValueUSD;
      exposedValueCount++;
    }
  }
  
  console.log('\n摘要:');
  console.log(`检查了 ${uniqueWallets} 个钱包地址`);
  console.log(`检查了 ${uniqueTokens} 个代币合约`);
  console.log(`发现 ${results.length} 个授权，其中 ${infiniteApprovals} 个为无限授权`);
  if (exposedValueCount > 0) {
    console.log(`总曝光价值: $${totalExposedValueUSD.toFixed(2)} USD`);
  }
}

// 导出结果到CSV
async function exportResults(results, filepath) {
  let csv = 'WalletAddress,TokenAddress,TokenSymbol,SpenderAddress,Allowance,Balance,ExposedAmount,Price,ExposedValueUSD,IsInfiniteApproval\n';
  
  for (const result of results) {
    const exposedValueUSD = result.exposedValueUSD !== null ? result.exposedValueUSD.toFixed(2) : 'unknown';
    const price = result.price !== null ? result.price : 'unknown';
    
    csv += `${result.walletAddress},${result.tokenAddress},${result.tokenSymbol},${result.spenderAddress},${result.allowance},${result.balance},${result.exposedAmount},${price},${exposedValueUSD},${result.isInfiniteApproval}\n`;
  }
  
  await fs.writeFile(filepath, csv);
}

// 缩短地址显示
function shortenAddress(address) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 执行主函数
main().catch(error => {
  logger.error('未捕获的错误:', error);
  process.exit(1);
}); 