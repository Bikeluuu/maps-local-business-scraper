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
  businessStatus?: string;
  googleUrl?: string;
  workingHours?: string;
  priceLevel?: string;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private seen = new Set<string>();

  async getPlaces(query: string, city: string, limit = 5): Promise<Place[]> {
    this.seen = new Set<string>();
    const places: Place[] = [];

    const browser = await puppeteer.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1920,1080",
        "--start-maximized",
        "--lang=en-US,en"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

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
        let newAdded = false;

        for (const card of cards) {
          if (places.length >= limit) break;

          const name = await card.evaluate((el) => el.querySelector(".fontHeadlineSmall")?.textContent?.trim());

          if (name && !this.seen.has(name)) {
            try {
              await card.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
              await new Promise((r) => setTimeout(r, 1000));
              await card.click();

              await this.waitForPlaceChange(page);
              await new Promise((r) => setTimeout(r, 2000));

              const scraped = await this.extractDetails(page, city);

              if (scraped.name) {
                if (!scraped.email && scraped.website) {
                  scraped.email = await this.scrapeEmailFromWebsite(browser, scraped.website);
                }
                this.seen.add(scraped.name);
                places.push(scraped);
                newAdded = true;
                this.logger.log(`[${city}] Found: ${scraped.name}`);
              }
            } catch {
              continue;
            }
          }
        }

        if (!newAdded) retryCount++;
        else retryCount = 0;

        await this.scrollFeed(page);
      }

      await browser.close();
      return places;
    } catch (error) {
      this.logger.error(`Error in city ${city}: ${error}`);
      await browser.close();
      return [];
    }
  }

  private async extractDetails(page: Page, cityName: string): Promise<Place> {
    const googleUrl = page.url();
    return page.evaluate(
      (url, city) => {
        const clean = (text: string) =>
          text
            .replace(/[^\x20-\x7EÀ-ÿ]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const getText = (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          return el ? clean(el.innerText) : "";
        };

        const name = getText("h1.DUwDvf") || getText(".lfPIob");
        if (!name) return {} as Place;

        const rows = document.querySelectorAll("table.eK0Z0c tr");
        const hours = Array.from(rows)
          .map((r) => clean((r as HTMLElement).innerText))
          .join(" | ");
        const priceSpan = Array.from(document.querySelectorAll("span")).find((s) =>
          /^[$€£]{1,4}$/.test(s.innerText.trim())
        );
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
          reviewsCount: reviewsText.replace(/[^0-9]/g, ""),
          businessStatus: getText(".Z67o1c"),
          workingHours: hours,
          priceLevel: priceSpan ? priceSpan.innerText.trim() : "",
          googleUrl: url
        };
      },
      googleUrl,
      cityName
    );
  }

  private async waitForPlaceChange(page: Page) {
    try {
      await page.waitForFunction(
        () => {
          const title = document.querySelector("h1.DUwDvf")?.textContent?.trim();
          return title && title.length > 0;
        },
        { timeout: 5000 }
      );
    } catch {
      //
    }
  }

  private async scrollFeed(page: Page) {
    await page.evaluate(() => {
      const el = document.querySelector('div[role="feed"]');
      if (el) el.scrollBy(0, 1000);
    });
    await new Promise((r) => setTimeout(r, 2000));
  }

  private async scrapeEmailFromWebsite(browser: Browser, url: string): Promise<string> {
    if (!url || url.includes("facebook.com") || url.includes("instagram.com")) return "";
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 });
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
