use futures_util::{future::join_all, StreamExt};
use reqwest::{Client, Url};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::time::Duration;

const SOURCES: [&str; 6] = [
    "fdroid",
    "github",
    "aptoide",
    "apkpure",
    "apkmirror",
    "uptodown",
];

pub fn search_url(source: &str, query: &str) -> String {
    let (base, key) = match source {
        "fdroid" => ("https://search.f-droid.org/", "q"),
        "github" => ("https://github.com/search?type=repositories", "q"),
        "aptoide" => ("https://en.aptoide.com/search", "query"),
        "apkpure" => ("https://apkpure.com/search", "q"),
        "apkmirror" => (
            "https://www.apkmirror.com/?post_type=app_release&searchtype=apk",
            "s",
        ),
        _ => ("https://en.uptodown.com/android/search", "query"),
    };
    let mut url = Url::parse(base).unwrap();
    url.query_pairs_mut().append_pair(key, query);
    url.to_string()
}

fn package_id(s: &str) -> bool {
    s.contains('.')
        && s.split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

async fn text(client: &Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Website returned HTTP {}", response.status()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.contains("<title>Just a moment...") || body.contains("<title>Access Denied") {
        return Err("This website requires a browser check".into());
    }
    Ok(body)
}

async fn json_get(client: &Client, url: &str) -> Result<Value, String> {
    serde_json::from_str(&text(client, url).await?)
        .map_err(|_| "The provider returned an unreadable response".into())
}

fn links(body: &str, selector: &str, base: &str) -> Vec<(String, String)> {
    let doc = Html::parse_document(body);
    let selector = Selector::parse(selector).unwrap();
    let base = Url::parse(base).unwrap();
    let mut found = Vec::new();
    for el in doc.select(&selector) {
        if let Some(mut url) = el.value().attr("href").and_then(|s| base.join(s).ok()) {
            url.set_fragment(None);
            if url.scheme() != "https" || found.iter().any(|(_, u)| u == url.as_str()) {
                continue;
            }
            let label = el
                .value()
                .attr("title")
                .map(str::to_string)
                .unwrap_or_else(|| el.text().collect::<Vec<_>>().join(" ").trim().to_string());
            found.push((label, url.to_string()));
        }
    }
    found
}

fn result(
    source: &str,
    name: &str,
    pkg: &str,
    version: &str,
    page: &str,
    apk: Option<String>,
) -> Value {
    json!({"name":name, "packageName":pkg, "suggestedVersionName":version, "source":source,
        "pageUrl":page, "apkUrl":apk, "verified":false, "architectures":[], "summary":""})
}

fn manual(source: &str, query: &str, reason: &str) -> Value {
    let mut value = result(
        source,
        &format!("Search {} for “{}”", source, query),
        "",
        "",
        &search_url(source, query),
        None,
    );
    value["manualReason"] = json!(reason);
    value
}

fn fdroid_details(pkg: &str, detail: &Value) -> Option<(String, String)> {
    let code = detail["suggestedVersionCode"].as_u64()?;
    let version = detail["packages"]
        .as_array()?
        .iter()
        .find(|p| p["versionCode"].as_u64() == Some(code))?["versionName"]
        .as_str()?
        .to_string();
    Some((
        format!("https://f-droid.org/repo/{}_{}.apk", pkg, code),
        version,
    ))
}

async fn fdroid(client: &Client, query: &str) -> Result<Vec<Value>, String> {
    let hits = if package_id(query) {
        vec![json!({"name":query,"url":format!("https://f-droid.org/packages/{}/",query)})]
    } else {
        let mut url = Url::parse("https://search.f-droid.org/api/search_apps").unwrap();
        url.query_pairs_mut().append_pair("q", query);
        let data = json_get(client, url.as_str()).await?;
        data["apps"]
            .as_array()
            .ok_or("F-Droid search is unavailable")?
            .clone()
    };
    Ok(join_all(hits.into_iter().take(8).map(|hit| async move {
        let page = hit["url"].as_str().unwrap_or("");
        let pkg = page.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let detail = json_get(
            client,
            &format!("https://f-droid.org/api/v1/packages/{}", pkg),
        )
        .await;
        let download = detail.ok().and_then(|d| fdroid_details(pkg, &d));
        let (apk, version) = download.map(|(u, v)| (Some(u), v)).unwrap_or_default();
        let mut r = result(
            "fdroid",
            hit["name"].as_str().unwrap_or(pkg),
            pkg,
            &version,
            page,
            apk,
        );
        r["summary"] = hit["summary"].clone();
        if r["apkUrl"].is_null() {
            r["manualReason"] = json!(
                "F-Droid did not provide a current APK version. Choose a version on its website."
            );
        }
        r
    }))
    .await)
}

async fn aptoide(client: &Client, query: &str) -> Result<Vec<Value>, String> {
    let mut url = Url::parse("https://ws75.aptoide.com/api/7/apps/search").unwrap();
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("limit", "10");
    let data = json_get(client, url.as_str()).await?;
    let list = data["datalist"]["list"]
        .as_array()
        .ok_or("Aptoide search is unavailable")?;
    Ok(list.iter().take(10).map(|a| {
        let pkg = a["package"].as_str().unwrap_or("");
        let page = format!("https://{}.en.aptoide.com/app", a["uname"].as_str().unwrap_or(pkg));
        let apk = a["file"]["path"].as_str().filter(|u|u.starts_with("https://")).map(str::to_string);
        let mut r = result("aptoide", a["name"].as_str().unwrap_or(pkg), pkg, a["file"]["vername"].as_str().unwrap_or(""), &page, apk);
        r["suggestedVersionCode"] = a["file"]["vercode"].clone();
        r["summary"] = json!(format!("Store: {}. Check the listed version before updating.",a["store"]["name"].as_str().unwrap_or("Aptoide")));
        if a.get("obb").is_some_and(|v| !v.is_null()) || a.get("aab").and_then(|v|v.get("required_splits")).and_then(Value::as_array).is_some_and(|v|!v.is_empty()) {
            r["apkUrl"] = Value::Null;
            r["manualReason"] = json!("This release needs additional files. Download the complete package from its website.");
        }
        r
    }).collect())
}

async fn github(client: &Client, query: &str) -> Result<Vec<Value>, String> {
    let mut url = Url::parse("https://api.github.com/search/repositories").unwrap();
    url.query_pairs_mut()
        .append_pair("q", &format!("{} android", query))
        .append_pair("sort", "stars")
        .append_pair("per_page", "5");
    let data = json_get(client, url.as_str()).await?;
    let repos = data["items"]
        .as_array()
        .ok_or("GitHub search is unavailable")?;
    let lists = join_all(repos.iter().map(|repo| async move {
        let full = repo["full_name"].as_str().unwrap_or("");
        let release = match json_get(
            client,
            &format!("https://api.github.com/repos/{}/releases/latest", full),
        )
        .await
        {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let assets = match release["assets"].as_array() {
            Some(v) => v,
            None => return Vec::new(),
        };
        assets
            .iter()
            .filter(|a| {
                a["name"]
                    .as_str()
                    .is_some_and(|n| n.to_lowercase().ends_with(".apk"))
            })
            .take(6)
            .map(|a| {
                let filename = a["name"].as_str().unwrap_or("app.apk");
                let mut r = result(
                    "github",
                    &format!("{} — {}", repo["name"].as_str().unwrap_or(full), filename),
                    "",
                    release["tag_name"].as_str().unwrap_or(""),
                    release["html_url"].as_str().unwrap_or(""),
                    a["browser_download_url"].as_str().map(str::to_string),
                );
                r["filename"] = json!(filename);
                r["summary"] = repo["description"].clone();
                r["repository"] = json!(full);
                r["architectures"] = json!(asset_architectures(filename));
                r
            })
            .collect::<Vec<_>>()
    }))
    .await;
    Ok(lists.into_iter().flatten().collect())
}

fn asset_architectures(name: &str) -> Vec<&'static str> {
    let n = name.to_lowercase();
    if n.contains("arm64") || n.contains("aarch64") {
        vec!["arm64-v8a"]
    } else if n.contains("armeabi") || n.contains("armv7") {
        vec!["armeabi-v7a"]
    } else if n.contains("x86_64") {
        vec!["x86_64"]
    } else if n.contains("x86") {
        vec!["x86"]
    } else if n.contains("universal") {
        vec!["universal"]
    } else {
        vec![]
    }
}

async fn apkpure(client: &Client, query: &str) -> Result<Vec<Value>, String> {
    let page = if package_id(query) {
        format!("https://apkpure.com/p/{}", query)
    } else {
        search_url("apkpure", query)
    };
    let body = text(client, &page).await?;
    let pages = if package_id(query) {
        vec![(query.to_string(), page.clone())]
    } else {
        links(&body, "a[data-dt-app], a[data-dt-package_name]", &page)
            .into_iter()
            .filter(|(_, u)| {
                Url::parse(u)
                    .ok()
                    .is_some_and(|u| u.host_str() == Some("apkpure.com"))
            })
            .take(4)
            .collect()
    };
    if pages.is_empty() {
        return Err("The website did not expose searchable app links".into());
    }
    Ok(join_all(pages.into_iter().map(|(name, url)| {
        let page = &page;
        let body = &body;
        async move {
            let html = if url == *page {
                Ok(body.clone())
            } else {
                text(client, &url).await
            };
            let details = html.ok().and_then(|s| pure_details(&s));
            let mut r = result("apkpure", &name, "", "", &url, None);
            if let Some((pkg, version)) = details {
                r["packageName"] = json!(pkg);
                r["suggestedVersionName"] = json!(version);
                r["apkUrl"] = json!(format!(
                    "https://d.apkpure.net/b/APK/{}?version=latest",
                    pkg
                ));
            } else {
                r["manualReason"] =
                    json!("The website requires you to choose the download in a browser.");
            }
            r
        }
    }))
    .await)
}

fn pure_details(body: &str) -> Option<(String, String)> {
    let doc = Html::parse_document(body);
    let selector = Selector::parse("a.normal-download-btn[data-dt-package_name]").unwrap();
    let el = doc.select(&selector).next()?;
    let pkg = el.value().attr("data-dt-package_name")?;
    if !package_id(pkg) {
        return None;
    }
    Some((
        pkg.to_string(),
        el.value().attr("data-dt-version").unwrap_or("").to_string(),
    ))
}

async fn mirror_download(client: &Client, page: &str) -> Result<String, String> {
    let mut current = page.to_string();
    for _ in 0..4 {
        let body = text(client, &current).await?;
        let candidates=links(&body,"a.downloadButton, a.accent_color[href*='android-apk-download'], a[href*='/download/?key=']",&current);
        let candidates = candidates
            .into_iter()
            .filter(|(_, u)| {
                Url::parse(u).ok().is_some_and(|u| {
                    u.host_str() == Some("www.apkmirror.com") && u.as_str() != current
                })
            })
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Err("Choose the APK variant on the website".into());
        }
        let next = candidates[0].1.clone();
        if next.contains("/download/?key=") {
            let response = client
                .get(&next)
                .header("Range", "bytes=0-511")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!(
                    "This download requires a browser (HTTP {})",
                    response.status()
                ));
            }
            let chunk = response
                .bytes_stream()
                .next()
                .await
                .ok_or("The download returned no package")?
                .map_err(|e| e.to_string())?;
            if !chunk.starts_with(b"PK") {
                return Err("The website requires a browser to finish the download".into());
            }
            return Ok(next);
        }
        current = next;
    }
    Err("The website requires a browser to finish the download".into())
}

fn mirror_variants(body: &str, page: &str) -> Vec<(String, String)> {
    let doc = Html::parse_document(body);
    let rows = Selector::parse(".table-row").unwrap();
    let cells = Selector::parse(".table-cell").unwrap();
    let mut variants = Vec::new();
    for row in doc.select(&rows) {
        let found = links(
            &row.html(),
            "a.accent_color[href*='android-apk-download']",
            page,
        );
        let detail = row
            .select(&cells)
            .skip(1)
            .map(|cell| {
                cell.text()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join(" · ");
        for (_, url) in found {
            if Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .as_deref()
                != Some("www.apkmirror.com")
            {
                continue;
            }
            if !variants.iter().any(|(_, existing)| existing == &url) {
                variants.push((detail.clone(), url));
            }
        }
    }
    variants
}

async fn mirror_results(client: &Client, name: &str, page: &str) -> Vec<Value> {
    let body = match text(client, page).await {
        Ok(body) => body,
        Err(reason) => {
            let mut r = result("apkmirror", name, "", "", page, None);
            r["manualReason"] = json!(reason);
            return vec![r];
        }
    };
    let mut variants = mirror_variants(&body, page);
    if variants.is_empty() {
        variants.push((String::new(), page.to_string()));
    }
    join_all(
        variants
            .into_iter()
            .take(4)
            .map(|(detail, url)| async move {
                let download = mirror_download(client, &url).await;
                let label = if detail.is_empty() {
                    name.to_string()
                } else {
                    format!("{} — {}", name, detail)
                };
                let mut r = result(
                    "apkmirror",
                    &label,
                    "",
                    "",
                    &url,
                    download.as_ref().ok().cloned(),
                );
                r["summary"] = json!(detail);
                if let Err(reason) = download {
                    r["manualReason"] = json!(reason);
                }
                r
            }),
    )
    .await
}

async fn html_source(client: &Client, source: &str, query: &str) -> Result<Vec<Value>, String> {
    let page = search_url(source, query);
    let body = text(client, &page).await?;
    let selector = if source == "apkmirror" {
        ".appRowTitle a"
    } else {
        "a[title^='Download'][href$='/android']"
    };
    let pages = links(&body, selector, &page)
        .into_iter()
        .filter(|(_, u)| {
            Url::parse(u).ok().is_some_and(|u| {
                if source == "apkmirror" {
                    u.host_str() == Some("www.apkmirror.com") && u.path().starts_with("/apk/")
                } else {
                    u.host_str()
                        .is_some_and(|h| h.ends_with(".en.uptodown.com"))
                }
            })
        })
        .take(4)
        .collect::<Vec<_>>();
    if pages.is_empty() {
        return Err(
            "No app links were exposed by this website. Search in your browser instead.".into(),
        );
    }
    if source == "apkmirror" {
        return Ok(join_all(
            pages
                .into_iter()
                .map(|(name, url)| async move { mirror_results(client, &name, &url).await }),
        )
        .await
        .into_iter()
        .flatten()
        .collect());
    }
    Ok(join_all(pages.into_iter().map(|(name, url)| async move {
        let download_page = if source == "uptodown" {
            format!("{}/download", url)
        } else {
            url.clone()
        };
        let download = if source == "apkmirror" {
            mirror_download(client, &url).await
        } else {
            match text(client, &download_page).await {
                Ok(body) => links(&body, "a[href*='dw.uptodown.com/dwn/']", &download_page)
                    .into_iter()
                    .next()
                    .map(|(_, u)| u)
                    .ok_or_else(|| {
                        "This download requires the website's browser check".to_string()
                    }),
                Err(e) => Err(e),
            }
        };
        let mut r = result(
            source,
            &name,
            "",
            "",
            &download_page,
            download.as_ref().ok().cloned(),
        );
        if let Err(reason) = download {
            r["manualReason"] = json!(reason);
        }
        r
    }))
    .await)
}

pub async fn search(query: &str, sources: &[String]) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("Enter an app name or package name (up to 200 characters)".into());
    }
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; AndroidToolkit/3.1.0)")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let batches=join_all(SOURCES.into_iter().filter(|s|sources.iter().any(|v|v==s)).map(|source| {
        let client=&client;
        async move {
            let outcome=tokio::time::timeout(Duration::from_secs(24),async {
                match source {"fdroid"=>fdroid(client,query).await,"aptoide"=>aptoide(client,query).await,"github"=>github(client,query).await,"apkpure"=>apkpure(client,query).await,_=>html_source(client,source,query).await}
            }).await.unwrap_or_else(|_|Err("Provider timed out. Continue on its website.".into()));
            match outcome {
                Ok(rows)=> {let direct=rows.iter().filter(|v|v["apkUrl"].is_string()).count(); let state=if rows.is_empty(){"empty"}else if direct==rows.len(){"direct"}else if direct>0{"mixed"}else{"browser"};
                    (rows.clone(),json!({"id":source,"state":state,"count":rows.len(),"direct":direct,"pageUrl":search_url(source,query)}))},
                Err(reason)=>(vec![manual(source,query,&reason)],json!({"id":source,"state":"browser","count":0,"direct":0,"message":reason,"pageUrl":search_url(source,query)})),
            }
        }
    })).await;
    let mut results = Vec::new();
    let mut providers = Vec::new();
    for (rows, status) in batches {
        results.extend(rows);
        providers.push(status);
    }
    Ok(json!({"ok":true,"results":results,"providers":providers}))
}

pub async fn store_download(source: &str, pkg: &str, page: &str) -> Result<Value, String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; AndroidToolkit/3.1.0)")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    match source {
        "fdroid" => {
            if !package_id(pkg) {
                return Err("Invalid package name".into());
            }
            let detail = json_get(
                &client,
                &format!("https://f-droid.org/api/v1/packages/{}", pkg),
            )
            .await?;
            let (url, version) =
                fdroid_details(pkg, &detail).ok_or("F-Droid did not provide a current download")?;
            Ok(json!({"url":url,"version":version}))
        }
        "aptoide" => {
            if !package_id(pkg) {
                return Err("Invalid package name".into());
            }
            let detail = json_get(
                &client,
                &format!(
                    "https://ws75.aptoide.com/api/7/app/get/package_name={}",
                    pkg
                ),
            )
            .await?;
            let data = &detail["nodes"]["meta"]["data"];
            let url = data["file"]["path"]
                .as_str()
                .filter(|u| u.starts_with("https://"))
                .ok_or("Aptoide did not provide a download")?;
            Ok(json!({"url":url,"version":data["file"]["vername"]}))
        }
        "apkmirror" => {
            if !page.starts_with("https://www.apkmirror.com/apk/") {
                return Err("Invalid APKMirror app page".into());
            }
            Ok(json!({"url":mirror_download(&client,page).await?}))
        }
        "uptodown" => {
            let url = Url::parse(page).map_err(|e| e.to_string())?;
            if url.scheme() != "https"
                || !url
                    .host_str()
                    .is_some_and(|h| h.ends_with(".en.uptodown.com"))
            {
                return Err("Invalid Uptodown app page".into());
            }
            let body = text(&client, page).await?;
            let (_, url) = links(&body, "a[href*='dw.uptodown.com/dwn/']", page)
                .into_iter()
                .next()
                .ok_or("This download requires the website's browser check")?;
            Ok(json!({"url":url}))
        }
        "epic" => {
            let page = "https://store.epicgames.com/en-US/mobile/android";
            let body = text(&client, page).await?;
            let (_, url) = links(&body, "a[href$='.apk']", page)
                .into_iter()
                .next()
                .ok_or("Epic requires its website to finish the download")?;
            Ok(json!({"url":url}))
        }
        _ => Err("Open the provider website to download this app".into()),
    }
}

pub async fn picks() -> Result<Value, String> {
    let client = Client::builder()
        .user_agent("AndroidToolkit/3.1.0")
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let apps = github(&client, "topic:android-app").await?;
    let mut repos = std::collections::HashSet::new();
    let picks = apps.into_iter().filter_map(|app| {
        let full = app["repository"].as_str()?.to_string();
        if !repos.insert(full.clone()) { return None; }
        Some(json!({"full_name":full,"name":full.rsplit('/').next().unwrap_or(&full),"description":app["summary"],"stars":0}))
    }).collect::<Vec<_>>();
    Ok(json!({"ok":true,"picks":picks}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fdroid_uses_real_version_and_never_fabricates_latest() {
        let d =
            json!({"suggestedVersionCode":42,"packages":[{"versionCode":42,"versionName":"1.2"}]});
        assert_eq!(
            fdroid_details("org.example.app", &d),
            Some((
                "https://f-droid.org/repo/org.example.app_42.apk".into(),
                "1.2".into()
            ))
        );
        assert_eq!(fdroid_details("org.example.app", &json!({})), None);
    }
    #[test]
    fn query_values_are_encoded_and_uptodown_uses_query_parameter() {
        let url = Url::parse(&search_url("uptodown", "A & B/+?")).unwrap();
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "query").unwrap().1,
            "A & B/+?"
        );
        assert!(!package_id("org.example/app"));
    }
    #[test]
    fn html_links_ignore_scripts_and_preserve_entities() {
        let a = links(
            "<a href='/apk/test-release/'>A &amp; B</a><a href='javascript:alert(1)'>Bad</a>",
            "a",
            "https://www.apkmirror.com/",
        );
        assert_eq!(
            a,
            vec![(
                "A & B".into(),
                "https://www.apkmirror.com/apk/test-release/".into()
            )]
        );
    }
    #[test]
    fn mirror_fragments_do_not_create_extra_variants() {
        let found = links("<a href='#downloads'>Scroll</a><a href='/release/variant-android-apk-download/'>APK</a><a href='/release/variant-android-apk-download/#comments'>Comments</a>", "a", "https://www.apkmirror.com/release/");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].1, "https://www.apkmirror.com/release/");
    }
    #[test]
    fn mirror_variants_keep_each_architecture_selectable() {
        let html = "<div class='table-row'><div class='table-cell'><a class='accent_color' href='/a/arm64-android-apk-download/'>APK</a></div><div class='table-cell'>arm64-v8a</div><div class='table-cell'>Android 8.0+</div></div><div class='table-row'><div class='table-cell'><a class='accent_color' href='/a/armv7-android-apk-download/'>APK</a></div><div class='table-cell'>armeabi-v7a</div></div>";
        let variants = mirror_variants(html, "https://www.apkmirror.com/a/");
        assert_eq!(variants.len(), 2);
        assert!(variants[0].0.contains("arm64-v8a"));
        assert!(variants[1].0.contains("armeabi-v7a"));
    }
    #[test]
    fn pure_metadata_matches_the_requested_app_not_an_ad() {
        assert_eq!(pure_details("<a class='normal-download-btn' data-dt-package_name='org.example.app' data-dt-version='2.0'></a>"),Some(("org.example.app".into(),"2.0".into())));
        assert!(pure_details("<a class='ad' data-dt-app='com.ad'></a>").is_none());
    }
    #[test]
    fn github_does_not_invent_abi_support() {
        assert!(asset_architectures("app.apk").is_empty());
        assert_eq!(asset_architectures("app-arm64-v8a.apk"), vec!["arm64-v8a"]);
    }
    #[tokio::test]
    #[ignore = "live provider smoke test"]
    async fn live_sources() {
        let r = search(
            "VLC",
            &SOURCES.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
        assert_eq!(r["providers"].as_array().unwrap().len(), 6);
        assert!(r["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["source"] == "fdroid" && v["apkUrl"].is_string()));
    }
}
