import { Injectable, Logger } from "@nestjs/common";
import puppeteer, { Page, Browser } from "puppeteer";

export interface Place {
  city: string;
  name: string;
  category?: string;
  address?: string;
  phone?: string;
  website: string;
  social: string;
  socialType: string;
  email?: string;
  rating?: string;
  reviewsCount?: string;
  plusCode?: string;
  businessStatus?: string;
  menuUrl?: string;
  serviceOptions?: string;
  googleUrl?: string;
  workingHours?: string;
  priceLevel?: string;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private seen = new Set<string>();

  async getPlaces(query: string, city: string, limit = 100): Promise<Place[]> {
    this.seen = new Set<string>();
    const places: Place[] = [];

    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,1000", "--lang=en-US,en"]
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1280, height: 1000 });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;

    try {
      await page.goto(url, { waitUntil: "networkidle2" });

      try {
        const btn = 'button[aria-label*="Accept all"], button[aria-label*="Agree"], button[aria-label*="Aceptar"]';
        await page.waitForSelector(btn, { timeout: 5000 });
        await page.click(btn);
      } catch {
        //
      }

      await page.waitForSelector('div[role="feed"]', { timeout: 15000 });

      let retryCount = 0;
      while (places.length < limit && retryCount < 5) {
        const cards = await page.$$('div[role="article"]');
        let newAddedThisScroll = false;

        for (const card of cards) {
          if (places.length >= limit) break;

          const name = await card.evaluate((el) => {
            const titleEl = el.querySelector('.fontHeadlineSmall, .qBF1Pd, [role="heading"]');
            return titleEl?.textContent?.replace(/\s+/g, " ").trim();
          });

          if (name && !this.seen.has(name)) {
            try {
              await card.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
              await new Promise((r) => setTimeout(r, 800));
              await card.click();

              await this.waitForPlaceChange(page, name);
              await new Promise((r) => setTimeout(r, 1500));

              const scraped = await this.extractDetails(page, city);

              if (scraped.name) {
                if (!scraped.email && scraped.website) {
                  scraped.email = await this.scrapeEmailFromWebsite(browser, scraped.website);
                }
                this.seen.add(scraped.name);
                places.push(scraped);
                newAddedThisScroll = true;
                this.logger.log(`[${places.length}] ${scraped.name}`);
              }
            } catch {
              continue;
            }
          }
        }

        const hasReachedEnd = await this.scrollFeed(page);
        if (newAddedThisScroll) {
          retryCount = 0;
        } else {
          retryCount++;
          if (hasReachedEnd && retryCount >= 2) break;
        }
      }

      await browser.close();
      return places;
    } catch (error) {
      this.logger.error(`Error: ${error}`);
      await browser.close();
      return [];
    }
  }

  private async extractDetails(page: Page, cityName: string): Promise<Place> {
    const googleUrl = page.url();
    return page.evaluate(
      (url, city) => {
        const getText = (sel: string) =>
          (document.querySelector(sel) as HTMLElement)?.innerText?.replace(/\s+/g, " ").trim() || "";

        const name = getText("h1.DUwDvf") || getText(".lfPIob") || getText(".fontHeadlineLarge");

        const rows = document.querySelectorAll("table.eK0Z0c tr");
        let hours = Array.from(rows)
          .map((r) => (r as HTMLElement).innerText.replace(/\s+/g, " ").trim())
          .join(" | ");
        if (!hours)
          hours =
            (document.querySelector('div[jsaction*="pane.schedule.expand"]') as HTMLElement)?.innerText?.split(
              "\n"
            )[0] || "";

        let price =
          document.querySelector('span[aria-label*="Price:"]')?.getAttribute("aria-label")?.replace("Price: ", "") ||
          "";
        if (!price) {
          const priceSpan = Array.from(document.querySelectorAll("span")).find((s) =>
            /^[$€£]{1,4}$/.test(s.innerText.trim())
          );
          price = priceSpan ? priceSpan.innerText : "";
        }

        const reviewsText = getText('span[aria-label*="reviews"]') || getText('button[aria-label*="reviews"]');

        return {
          city,
          name,
          category: getText('button[jsaction*="pane.rating.category"]'),
          address: getText('button[data-item-id="address"]'),
          phone: getText('button[data-item-id^="phone"]'),
          website: (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement)?.href || "",
          social: "",
          socialType: "",
          email: "",
          rating: getText("span.ceNzR") || getText("div.F7nice span"),
          reviewsCount: reviewsText.replace(/[^0-9,.]/g, "").trim() || reviewsText,
          businessStatus: getText(".Z67o1c"),
          workingHours: hours,
          priceLevel: price,
          googleUrl: url
        };
      },
      googleUrl,
      cityName
    );
  }

  private async waitForPlaceChange(page: Page, name: string) {
    try {
      await page.waitForFunction(
        () => {
          const title = document.querySelector("h1.DUwDvf")?.textContent?.replace(/\s+/g, " ").trim();
          return title && title.length > 0;
        },
        { timeout: 5000 },
        name
      );
    } catch {
      //
    }
  }

  private async scrollFeed(page: Page): Promise<boolean> {
    return page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      const prevHeight = el.scrollHeight;
      el.scrollBy(0, 1000);
      await new Promise((r) => setTimeout(r, 2000));
      return el.scrollHeight === prevHeight;
    }, 'div[role="feed"]');
  }

  private async scrapeEmailFromWebsite(browser: Browser, url: string): Promise<string> {
    if (!url || url.includes("facebook.com") || url.includes("instagram.com")) return "";
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      const email = await page.evaluate(() => {
        const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
        return document.body.innerText.match(regex)?.[0] || "";
      });
      await page.close();
      return email;
    } catch {
      await page.close();
      return "";
    }
  }
}
