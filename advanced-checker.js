#!/usr/bin/env node

import { ethers } from 'ethers';
import { Command } from 'commander';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import chalk from 'chalk';
import Table from 'cli-table3';

// 加载环境变量
dotenv.config();

// ERC20代币ABI
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
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
  .name('advanced-address-checker')
  .description('高级版本：检查区块链地址对特定代币的所有授权情况')
  .version('1.0.0')
  .option('-a, --address <address>', '单个钱包地址')
  .option('-af, --address-file <path>', '包含钱包地址的文件路径（每行一个地址）')
  .option('-t, --token <address>', '单个代币合约地址')
  .option('-tf, --token-file <path>', '包含代币合约地址的文件路径（每行一个地址）')
  .option('-b, --blocks <number>', '要向前查找的区块数（用于查找Approval事件）', '1000000')
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

    // 查找授权和检查当前授权状态
    logger.info('开始查找授权事件并检查当前授权状态...');
    const results = await findAndCheckApprovals(provider, addresses, tokens, parseInt(options.blocks));

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

// 查找授权事件并检查当前授权状态
async function findAndCheckApprovals(provider, addresses, tokens, lookbackBlocks) {
  const results = [];
  const currentBlock = await provider.getBlockNumber();
  const startBlock = Math.max(0, currentBlock - lookbackBlocks);
  
  logger.info(`当前区块高度: ${currentBlock}, 将查找从区块 ${startBlock} 开始的授权事件`);

  // 计算总任务数，用于进度显示
  const totalTasks = tokens.length * addresses.length;
  let completedTasks = 0;
  
  // 进度显示相关变量
  const startTime = Date.now();
  let lastUpdate = startTime;
  let lastProgress = 0;
  
  // 创建进度更新函数
  const updateProgress = (force = false, currentAction = '') => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000; // 秒
    const percent = Math.floor((completedTasks / totalTasks) * 100);
    
    // 每500毫秒更新一次进度，或者在强制更新时
    if (force || now - lastUpdate >= 500 || percent > lastProgress) {
      lastUpdate = now;
      lastProgress = percent;
      
      // 计算预估剩余时间
      let eta = '计算中...';
      if (completedTasks > 0) {
        const timePerTask = elapsed / completedTasks;
        const remainingTasks = totalTasks - completedTasks;
        const remainingTime = timePerTask * remainingTasks;
        
        // 格式化剩余时间
        if (remainingTime < 60) {
          eta = `约${Math.ceil(remainingTime)}秒`;
        } else if (remainingTime < 3600) {
          eta = `约${Math.ceil(remainingTime / 60)}分钟`;
        } else {
          eta = `约${(remainingTime / 3600).toFixed(1)}小时`;
        }
      }
      
      // 构建进度消息
      let message = `\r进度: [${completedTasks}/${totalTasks}] ${percent}% 完成 | 预计剩余时间: ${eta}`;
      if (currentAction) {
        message += ` | ${currentAction}`;
      }
      
      process.stdout.write(message);
    }
  };
  
  // 设置定时器，确保即使在长时间查询过程中也能更新进度
  const progressInterval = setInterval(() => {
    updateProgress();
  }, 1000);

  try {
    for (const tokenInfo of tokens) {
      try {
        const tokenAddress = tokenInfo.address;
        logger.debug(`处理代币: ${tokenAddress}`);
        
        // 更新进度消息
        updateProgress(true, `处理代币 ${tokenAddress}`);
        
        // 创建代币合约实例
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        
        // 获取代币信息
        let symbol, decimals, price;
        try {
          [symbol, decimals] = await Promise.all([
            tokenContract.symbol(),
            tokenContract.decimals()
          ]);
          logger.debug(`代币 ${tokenAddress} 信息: symbol=${symbol}, decimals=${decimals}`);
          
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
        
        // 使用Promise.all对多个地址并行查询，但限制并发数防止超出速率限制
        const batchSize = 3; // 可以根据RPC服务商的限制调整
        const addressBatches = [];
        
        // 将addresses分成批次
        for (let i = 0; i < addresses.length; i += batchSize) {
          addressBatches.push(addresses.slice(i, i + batchSize));
        }
        
        // 按批次处理addresses
        for (const batch of addressBatches) {
          // 创建一个包含当前批次所有地址的查询任务数组
          const batchTasks = batch.map(async (address) => {
            try {
              updateProgress(false, `查找地址 ${shortenAddress(address)} 的 ${symbol || tokenAddress} 授权`);
              
              logger.debug(`  查找地址 ${address} 的授权事件`);
              
              // 获取账户余额
              let balance = ethers.getBigInt(0);
              try {
                balance = await tokenContract.balanceOf(address);
                logger.debug(`  地址 ${address} 的 ${symbol} 余额: ${ethers.formatUnits(balance, decimals)}`);
              } catch (error) {
                logger.warn(`获取 ${address} 的 ${symbol} 余额出错:`, error.message);
              }
              
              // 创建过滤器来查找该地址的所有Approval事件
              const filter = tokenContract.filters.Approval(address);
              
              try {
                // 获取过去的授权事件
                updateProgress(false, `查询地址 ${shortenAddress(address)} 的历史授权事件`);
                const events = await tokenContract.queryFilter(filter, startBlock, currentBlock);
                logger.debug(`  发现 ${events.length} 个授权事件`);
                
                // 用于跟踪已处理的spender，避免重复
                const processedSpenders = new Set();
                
                // 处理每个事件
                for (const event of events) {
                  const spender = event.args.spender;
                  
                  // 如果已经处理过这个spender，跳过
                  if (processedSpenders.has(spender)) continue;
                  processedSpenders.add(spender);
                  
                  try {
                    updateProgress(false, `检查 ${shortenAddress(address)} 对 ${shortenAddress(spender)} 的授权`);
                    
                    // 获取当前授权金额
                    const allowance = await tokenContract.allowance(address, spender);
                    
                    // 检查是否是无限授权 (2^256 - 1)
                    const maxUint256 = ethers.MaxUint256;
                    const isInfiniteApproval = allowance.toString() === maxUint256.toString();
                    
                    // 如果授权金额为0，且我们只关心当前有效的授权，可以跳过
                    if (allowance.toString() === '0') {
                      logger.debug(`  跳过 ${address} 对 ${spender} 的零值授权`);
                      continue;
                    }
                    
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
                    logger.warn(`检查 ${address} 对 ${spender} 的当前授权出错:`, error.message);
                  }
                }
              } catch (error) {
                logger.warn(`查询 ${address} 的授权事件出错:`, error.message);
              }
            } finally {
              // 无论成功与否，都更新进度
              completedTasks++;
              updateProgress();
            }
          });
          
          // 并行执行批次内的所有任务
          await Promise.all(batchTasks);
        }
      } catch (error) {
        logger.warn(`处理代币 ${tokenInfo.address} 出错:`, error.message);
        
        // 如果处理代币出错，更新该代币的所有地址的进度
        const remainingAddresses = addresses.length - completedTasks % addresses.length;
        completedTasks += remainingAddresses;
        updateProgress(true);
      }
    }
  } finally {
    // 停止进度更新定时器
    clearInterval(progressInterval);
    
    // 确保显示最终进度
    process.stdout.write(`\r进度: [${totalTasks}/${totalTasks}] 100% 完成！${' '.repeat(50)}\n`);
  }

  return results;
}

// 显示结果
function displayResults(results) {
  if (results.length === 0) {
    logger.info('未找到任何授权信息');
    return;
  }

  // 计算摘要信息（这部分不会导致栈溢出）
  const uniqueWallets = new Set(results.map(r => r.walletAddress)).size;
  const uniqueTokens = new Set(results.map(r => r.tokenAddress)).size;
  const uniqueSpenders = new Set(results.map(r => r.spenderAddress)).size;
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
  
  // 安全显示结果 - 处理大数据量
  const MAX_DISPLAY_ROWS = 100; // 限制表格显示最多100行
  
  console.log(`\n总共找到 ${results.length} 个授权结果。`);
  
  if (results.length > MAX_DISPLAY_ROWS) {
    console.log(`数据量过大，仅显示前 ${MAX_DISPLAY_ROWS} 行和最重要的授权。所有数据都已保存在导出的CSV文件中。`);
    
    // 按曝光价值排序，找出价值最高的结果
    const sortedResults = [...results]
      .filter(r => r.exposedValueUSD !== null)
      .sort((a, b) => b.exposedValueUSD - a.exposedValueUSD);
    
    // 获取高价值和无限授权的结果
    const highValueResults = sortedResults.slice(0, MAX_DISPLAY_ROWS/2);
    const infiniteResults = results
      .filter(r => r.isInfiniteApproval)
      .slice(0, MAX_DISPLAY_ROWS/2);
    
    // 合并高价值和无限授权结果并去重
    const importantResults = [...highValueResults];
    for (const result of infiniteResults) {
      if (!importantResults.some(r => 
          r.walletAddress === result.walletAddress && 
          r.tokenAddress === result.tokenAddress &&
          r.spenderAddress === result.spenderAddress)) {
        importantResults.push(result);
      }
    }
    
    // 限制最终显示的结果数量
    const displayResults = importantResults.slice(0, MAX_DISPLAY_ROWS);
    
    // 创建表格
    displayResultTable(displayResults);
  } else {
    // 数据量适中，正常显示
    displayResultTable(results);
  }
  
  // 显示摘要
  console.log('\n摘要:');
  console.log(`检查了 ${uniqueWallets} 个钱包地址`);
  console.log(`检查了 ${uniqueTokens} 个代币合约`);
  console.log(`发现 ${uniqueSpenders} 个spender合约有授权`);
  console.log(`发现 ${results.length} 个授权，其中 ${infiniteApprovals} 个为无限授权`);
  if (exposedValueCount > 0) {
    console.log(`总曝光价值: $${totalExposedValueUSD.toFixed(2)} USD`);
  }
}

// 新增辅助函数，用于显示表格（避免长函数栈溢出）
function displayResultTable(results) {
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

  // 填充表格数据，使用批处理避免栈溢出
  const BATCH_SIZE = 20;
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    
    for (const result of batch) {
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
    
    // 在批处理中间添加微小延迟以避免栈溢出
    if (i + BATCH_SIZE < results.length) {
      // 这里实际运行时不会真的延迟，只是给JavaScript引擎一个让出控制权的机会
      // 避免同步调用导致栈构建过深
    }
  }

  try {
    // 安全地渲染表格
    console.log(table.toString());
  } catch (error) {
    // 如果仍然出错，使用更简单的格式显示
    console.log('表格渲染失败，使用简化格式显示结果:');
    console.log('----------------------------------------------------');
    
    for (const result of results) {
      console.log(
        `${shortenAddress(result.walletAddress)} | ${result.tokenSymbol} | ` +
        `${shortenAddress(result.spenderAddress)} | 授权: ${result.allowance} | ` +
        `曝光: ${result.exposedAmount} | 价值: ${result.exposedValueUSD !== null ? '$' + result.exposedValueUSD.toFixed(2) : '未知'} | ` +
        `无限授权: ${result.isInfiniteApproval ? '是' : '否'}`
      );
    }
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