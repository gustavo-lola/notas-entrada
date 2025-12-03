import puppeteer, { Page } from "puppeteer"
import fs from 'fs/promises'
import cliProgress from 'cli-progress'
import path from 'path'
import { Command } from "commander"

const program = new Command()

program
  .version("1.0.0")
  .description("Notas de entrada-XML")
  .option("-o, --output <output path>", "Caminho de saida")
  .parse(process.argv)

const options = program.opts()
const outputBasePath = options.output ? [options.output] : [__dirname, 'output']

async function waitForTargetDownload(page: Page) {
  const newTarget = await page.browserContext().waitForTarget(
    target => target.url().startsWith('blob:'),
    { timeout: 120000 }
  )
  const newPage = await newTarget.page() as Page
  const blobUrl = newPage.url()

  const blobData = await page.evaluate(async (url) => {
    const response = await fetch(url)
    const blob = await response.blob()

    const reader = new FileReader()
    return new Promise(resolve => {
      reader.onloadend = () => {
        resolve(reader.result)
      }
      reader.readAsDataURL(blob)
    })
  }, blobUrl) as string

  await newPage.close()

  return blobData
}

async function waitForDownload(page: Page) {
  try {
    await page.waitForNetworkIdle({ timeout: 10000 })
    await page.waitForSelector('.black-overlay', { timeout: 5000 })
    await page.waitForSelector('.black-overlay', { hidden: true, timeout: 100000 })
    await new Promise(r => setTimeout(r, 2000))
  } catch (e) {
    console.log('Overlay não detectado, continuando...')
  }
}

async function ensureDirectory(dirPath: string) {
  try {
    await fs.access(dirPath)
  } catch {
    await fs.mkdir(dirPath, { recursive: true })
  }
}

export async function main() {
  const bar = new cliProgress.SingleBar({
    format: ' {bar} | {empresa}: {status} | {value}/{total}'
  }, cliProgress.Presets.shades_classic)

  const csv = await fs.readFile(path.join(__dirname, 'input.csv'), { encoding: 'utf-8' })
  const rows = csv.split('\n').filter(r => r.trim()).map(r => r.split(';'))
  const headers = rows[0]
  const data = rows.slice(1).map(row =>
    Object.fromEntries(row.map((value, i) => [headers[i], value.trim()]))
  )

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ['--start-maximized']
  })
  const page = await browser.newPage()

  bar.start(data.length, 0)

  for (let i = 0; i < data.length; i++) {
    const row = data[i]
    const companyKey = Object.keys(row)[0]

    try {
      bar.update(i + 1, { empresa: row[companyKey], status: 'Autenticando' })

      await page.goto('https://contribuinte.sefaz.al.gov.br/cobrancadfe/#/calculo-nfe', {
        waitUntil: 'networkidle2'
      })

      await page.waitForSelector('#username', { timeout: 10000 })
      await page.type('#username', row.LOGIN, { delay: 10 })
      await page.type('#password', row.SENHA, { delay: 10 })

      await page.click('form button[type=submit]')
      await page.waitForNavigation({ waitUntil: 'networkidle2' })

      const userLoggedSelector = '#logout'
      await page.waitForSelector(userLoggedSelector, { timeout: 10000 })

      bar.update(i + 1, { empresa: row[companyKey], status: 'Buscando novos relatórios' })
      await page.goto('https://contribuinte.sefaz.al.gov.br/malhafiscal/#/relatorio-contribuinte', {
        waitUntil: 'networkidle2'
      })

      const element = await page.waitForSelector('body > jhi-main > div.container-fluid > div > jhi-relatorio-contribuinte > div > div > div.row > div > select > option')
      const option = await element?.evaluate(el => el.textContent?.trim() || 'sem-nome')

      const outputDir = path.join(...outputBasePath, `${row[companyKey]} - ${option}`)
      await ensureDirectory(outputDir)

      const endDate = new Date()
      endDate.setDate(0)

      const startDate = new Date(endDate)
      startDate.setDate(1)

      const formatDateForInput = (date: Date) => {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
      }

      await page.evaluate((dateStr) => {
        const input = document.querySelector('#dataFinal') as HTMLInputElement
        if (input) {
          input.value = dateStr
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, formatDateForInput(endDate))

      await page.evaluate((dateStr) => {
        const input = document.querySelector('#dataInicial') as HTMLInputElement
        if (input) {
          input.value = dateStr
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, formatDateForInput(startDate))

      await page.select('#formatoRelatorio', '1')

      const downloadButton = 'body > jhi-main > div.container-fluid > div > jhi-relatorio-contribuinte > div > div > div.card-body.mb-0.pb-0 > div:nth-child(9) > table > tbody > tr:nth-child(1) > td > div > button'
      await page.click(downloadButton)

      bar.update(i + 1, { empresa: row[companyKey], status: 'Baixando relatório PDF via blob' })

      const blobData = await waitForTargetDownload(page)
      const pdfOutput = path.join(outputDir, `notas-entrada-${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}.pdf`)
      await fs.writeFile(pdfOutput, blobData.split(',')[1], 'base64')

      bar.update(i + 1, { empresa: row[companyKey], status: 'PDF salvo com sucesso' })
      await new Promise(resolve => setTimeout(resolve, 1000))

      bar.update(i + 1, { empresa: row[companyKey], status: 'Logout' })
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await page.goto('about:blank')

      await new Promise(resolve => setTimeout(resolve, 1000))

    } catch (e: any) {
      console.error(`\nErro ao processar ${row[companyKey]}:`, e.message)

      try {
        await page.evaluate(() => {
          localStorage.clear()
          sessionStorage.clear()
        })
        await page.goto('about:blank')
      } catch { }
    }
  }

  bar.stop()
  await browser.close()
  console.log(' Processo concluído! ')
}

main().catch(console.error)
