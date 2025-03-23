# Address Checker

这个工具用于检查一系列区块链地址是否对特定代币授予了对某些合约的批准权限。

## 功能特点

- 支持批量检查多个钱包地址
- 支持检查对多个代币合约的授权情况
- 支持多种区块链网络（以太坊、BSC、Polygon等）
- 可以检测无限授权（infinite approval）
- 计算每个授权的实际曝光量和美元价值
- 智能进度显示功能：
  - 显示实时进度百分比 [35/100] 35%
  - 提供预计剩余时间
  - 显示当前正在处理的操作
  - 即使在长时间查询中也保持更新
- 输出格式化的报告，便于分析
- 高级模式：可通过分析历史事件自动发现所有授权对象

## 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/address-checker.git
cd address-checker

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑.env文件，填入您的API密钥
```

## 使用方法

### 基本模式

在基本模式下，需要明确指定要检查的代币合约和授权接收者（spender）合约。

```bash
# 方法1：直接使用node运行（推荐）
node index.js --address 0x123456... --token 0xabcdef... --spender 0x789abc...

# 检查多个地址对多个代币授权给多个spender（从文件读取）
node index.js --address-file ./data/addresses.txt --token-file ./data/tokens.txt --spender-file ./data/spenders.txt

# 导出CSV报告
node index.js --address-file ./data/addresses.txt --token-file ./data/tokens.txt --spender-file ./data/spenders.txt --export report.csv

# 方法2：使用npm start（注意参数传递方式）
npm start -- --address 0x123456... --token 0xabcdef... --spender 0x789abc...
```

> **注意**：使用`npm start --`时，确保将参数放在`--`之后，这样才能正确传递给脚本。如果遇到参数解析问题，建议直接使用`node index.js`方式运行。

### 高级模式

高级模式可以通过分析历史授权事件，自动发现钱包授权过的所有spender合约，不需要预先知道spender合约地址。

```bash
# 使用高级模式检查单个地址对单个代币的所有授权
node advanced-checker.js --address 0x123456... --token 0xabcdef...

# 检查多个地址对多个代币的所有授权（从文件读取）
node advanced-checker.js --address-file ./data/addresses.txt --token-file ./data/tokens.txt

# 自定义查询区块范围（默认查询过去1000000个区块）
node advanced-checker.js --address-file ./data/addresses.txt --token-file ./data/tokens.txt --blocks 500000

# 导出CSV报告
node advanced-checker.js --address-file ./data/addresses.txt --token-file ./data/tokens.txt --export report.csv
```

### 文件格式

addresses.txt（一行一个地址）:
```
0x123456789abcdef...
0xfedcba987654321...
```

tokens.txt（代币合约地址和价格，用逗号分隔）:
```
# 格式: 合约地址,价格(USD)
0xabcdef123456789...,1
0x987654321fedcba...,65000
```

如果未提供价格，程序会尝试从代币符号推断：
- USDT, USDC, DAI, BUSD等稳定币默认价格为1美元
- 其他代币将显示为"未知"价格

spenders.txt（要检查的spender合约地址）:
```
0x111222333444555...
0x666777888999000...
```

## 输出示例

程序将输出一个表格，显示每个地址对每个代币的授权情况：

| 钱包地址 | 代币 | Spender合约 | 授权金额 | 余额 | 曝光量 | 曝光价值(USD) | 无限授权 |
|---------|-----|------------|---------|------|-------|--------------|---------|
| 0x123.. | USDT | 0xabc... | 1000.0 | 500.0 | 500.0 | $500.00 | 否 |
| 0x123.. | USDT | 0xdef... | ∞ | 500.0 | 500.0 | $500.00 | 是 |
| 0x456.. | WETH | 0xabc... | 10.0 | 5.0 | 5.0 | $20000.00 | 否 |

### 名词解释

- **授权金额**：允许spender合约使用的最大代币数量
- **余额**：钱包当前持有的代币数量
- **曝光量**：实际处于风险中的代币数量（授权金额与余额中的较小值）
- **曝光价值**：曝光量乘以代币价格（美元）
- **无限授权**：是否授权了无限数量的代币

## 注意事项

- 需要有效的API密钥才能连接到区块链网络
- 大量地址检查可能会受到RPC提供商的速率限制
- 无限授权通常表示为最大uint256值或特定的大数值
- 高级模式通过查询历史事件，可能需要更长时间完成
- 在使用高级模式时，建议设置合理的`--blocks`参数，以平衡查询速度和结果完整性
- 曝光价值计算依赖于提供的代币价格，若未提供则无法计算
- 当处理极大数据量（如上万条授权记录）时，程序会自动限制控制台输出，只显示最重要的授权信息，但所有数据都会导出到CSV文件中

## 常见问题

**问：我收到"超出请求限制"错误怎么办？**

答：降低并发请求数量，或者使用拥有更高速率限制的RPC提供商。

**问：如何确定哪些授权是危险的？**

答：一般来说，无限授权（显示为"∞"）可能存在安全风险，尤其是授权给不知名的合约。另外，高曝光价值的授权也需要特别关注。建议在不需要时撤销这些授权。

**问：如何撤销授权？**

答：可以通过调用代币合约的`approve`函数，将授权金额设为0来撤销授权。多数钱包如MetaMask也提供了撤销授权的功能。

**问：为什么高级模式找不到某些授权？**

答：高级模式依赖于分析历史事件，如果授权发生在`--blocks`参数指定的区块范围之外，则无法检测到。可以增加`--blocks`参数值，但请注意这会增加查询时间。

**问：如何添加更多代币价格？**

答：在tokens.txt文件中按照`合约地址,价格`的格式添加价格信息。对于未提供价格的稳定币，程序会自动设置为1美元。 