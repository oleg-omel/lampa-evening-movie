/*
 * «Фильм на вечер» — плагин для Lampa.
 * Подбирает один фильм с хорошим рейтингом, у которого уже вышел цифровой
 * релиз (значит, есть WEB-DL/BluRay, а не экранка), с учётом того, что вы
 * уже смотрели, что понравилось и что нет.
 */
(function () {
    'use strict';

    if (window.evening_movie_plugin) return;
    window.evening_movie_plugin = true;

    var DB_KEY = 'evening_movie_db';
    var DAY = 24 * 60 * 60 * 1000;
    var SKIP_DAYS = 30;          // «другой фильм» — не предлагать снова 30 дней
    var DIGITAL_DELAY_DAYS = 75; // фильм младше — проверяем наличие цифрового релиза
    var EXCLUDED_GENRES = [16, 99, 10770]; // мультфильмы, документальные, ТВ-фильмы

    var network = new Lampa.Reguest();

    // ---------- хранилище ----------

    function db() {
        var data = Lampa.Storage.get(DB_KEY, '{}');
        if (!data || typeof data !== 'object') data = {};
        data.items = data.items || {};     // id -> {status: liked|disliked|watched, ...}
        data.skipped = data.skipped || {}; // id -> timestamp
        return data;
    }

    function saveDb(data) {
        Lampa.Storage.set(DB_KEY, data);
    }

    function setStatus(movie, status) {
        var data = db();
        if (status) {
            data.items[movie.id] = {
                id: movie.id,
                title: movie.title || movie.name,
                year: (movie.release_date || '').slice(0, 4),
                genres: genreIds(movie),
                status: status,
                time: Date.now()
            };
        } else {
            delete data.items[movie.id];
        }
        if (data.pending && data.pending.id == movie.id) delete data.pending;
        saveDb(data);
    }

    function getStatus(id) {
        var item = db().items[id];
        return item ? item.status : '';
    }

    function genreIds(movie) {
        if (movie.genre_ids) return movie.genre_ids.slice();
        return (movie.genres || []).map(function (g) { return g.id; });
    }

    // ---------- настройки ----------

    function setting(name, def) {
        var value = Lampa.Storage.get(name, def);
        return value === '' || value === undefined || value === null ? def : value;
    }

    function prefs() {
        return {
            min_rating: parseFloat(setting('evening_min_rating', '7')),
            min_votes: parseInt(setting('evening_min_votes', '500'), 10),
            min_year: parseInt(setting('evening_min_year', '1980'), 10),
            exclude_genres: setting('evening_exclude_genres', true) !== false && setting('evening_exclude_genres', true) !== 'false',
            jacred: setting('evening_jacred_check', false) === true || setting('evening_jacred_check', false) === 'true',
            jacred_url: String(setting('evening_jacred_url', 'jacred.xyz'))
        };
    }

    function addSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: 'evening_movie',
            name: 'Фильм на вечер',
            icon: ICON
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: {
                name: 'evening_min_rating',
                type: 'select',
                values: { '6.5': '6.5+', '7': '7.0+', '7.5': '7.5+', '8': '8.0+' },
                default: '7'
            },
            field: { name: 'Минимальный рейтинг TMDB', description: 'Фильмы ниже не предлагаются' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: {
                name: 'evening_min_votes',
                type: 'select',
                values: { '200': '200+', '500': '500+', '1000': '1000+', '3000': '3000+' },
                default: '500'
            },
            field: { name: 'Минимум голосов', description: 'Чтобы рейтинг был честным' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: {
                name: 'evening_min_year',
                type: 'select',
                values: { '1950': 'с 1950', '1980': 'с 1980', '1990': 'с 1990', '2000': 'с 2000', '2010': 'с 2010' },
                default: '1980'
            },
            field: { name: 'Год выпуска' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: { name: 'evening_exclude_genres', type: 'trigger', default: true },
            field: { name: 'Без мультфильмов и документалок' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: { name: 'evening_jacred_check', type: 'trigger', default: false },
            field: { name: 'Проверять 1080p+ на торрентах', description: 'Через JacRed: предлагать только фильмы, у которых есть раздача 1080p или 4K' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: { name: 'evening_jacred_url', type: 'input', values: '', placeholder: 'jacred.xyz', default: 'jacred.xyz' },
            field: { name: 'Адрес JacRed' }
        });

        Lampa.SettingsApi.addParam({
            component: 'evening_movie',
            param: { name: 'evening_reset', type: 'button' },
            field: { name: 'Сбросить историю оценок' },
            onChange: function () {
                Lampa.Select.show({
                    title: 'Удалить все оценки плагина?',
                    items: [{ title: 'Да, удалить', reset: true }, { title: 'Отмена' }],
                    onSelect: function (item) {
                        if (item.reset) {
                            saveDb({});
                            Lampa.Noty.show('История очищена');
                        }
                        Lampa.Controller.toggle('settings_component');
                    },
                    onBack: function () { Lampa.Controller.toggle('settings_component'); }
                });
            }
        });
    }

    // ---------- TMDB ----------

    function lang() {
        return Lampa.Storage.get('language', 'ru') || 'ru';
    }

    function tmdbUrl(path, params) {
        var query = ['api_key=' + Lampa.TMDB.key(), 'language=' + lang()];
        for (var key in params) {
            if (params[key] !== undefined && params[key] !== '') query.push(key + '=' + encodeURIComponent(params[key]));
        }
        return Lampa.TMDB.api(path + '?' + query.join('&'));
    }

    function request(url, done) {
        network.timeout(15000);
        network.quiet(url, function (json) {
            done(typeof json === 'string' ? safeJson(json) : json);
        }, function () {
            done(null);
        });
    }

    function safeJson(str) {
        try { return JSON.parse(str); } catch (e) { return null; }
    }

    function dateShift(days) {
        var d = new Date(Date.now() - days * DAY);
        return d.toISOString().slice(0, 10);
    }

    // ---------- что уже известно о вкусах ----------

    function lampaList(type) {
        try {
            return (Lampa.Favorite.get({ type: type }) || []).filter(function (c) { return c && c.id && !c.original_name; });
        } catch (e) {
            return [];
        }
    }

    function lampaMarks(card) {
        try { return Lampa.Favorite.check(card) || {}; } catch (e) { return {}; }
    }

    function lampaWatchedPercent(card) {
        try { return card.original_title ? Lampa.Timeline.watched(card) || 0 : 0; } catch (e) { return 0; }
    }

    // Профиль: веса жанров + фильмы-«семена» для рекомендаций
    function buildProfile() {
        var data = db();
        var weights = {};
        var liked = [];
        var seen = {};

        function add(genres, w) {
            (genres || []).forEach(function (g) { weights[g] = (weights[g] || 0) + w; });
        }

        Object.keys(data.items).forEach(function (id) {
            var item = data.items[id];
            if (item.status === 'liked') { add(item.genres, 2); liked.push(item); }
            else if (item.status === 'disliked') add(item.genres, -2);
            else if (item.status === 'watched') add(item.genres, 0.3);
        });

        // родные отметки Lampa тоже учитываем
        lampaList('like').forEach(function (card) {
            if (!data.items[card.id]) { add(genreIds(card), 1.5); liked.push({ id: card.id, title: card.title }); }
            seen[card.id] = true;
        });
        lampaList('viewed').forEach(function (card) {
            if (!data.items[card.id]) add(genreIds(card), 0.3);
            seen[card.id] = true;
        });
        lampaList('thrown').forEach(function (card) {
            if (!data.items[card.id]) add(genreIds(card), -1.5);
            seen[card.id] = true;
        });

        return { weights: weights, liked: liked, seen: seen, data: data };
    }

    function excluded(movie, profile) {
        if (profile.data.items[movie.id] || profile.seen[movie.id]) return true;
        var skipped = profile.data.skipped[movie.id];
        if (skipped && Date.now() - skipped < SKIP_DAYS * DAY) return true;
        var marks = lampaMarks(movie);
        if (marks.viewed || marks.thrown) return true;
        if (lampaWatchedPercent(movie) >= 70) return true;
        return false;
    }

    function passesFilters(movie, p) {
        if (!movie || !movie.id || movie.adult || movie.video) return false;
        if (!movie.poster_path || !movie.release_date) return false;
        if ((movie.vote_average || 0) < p.min_rating) return false;
        if ((movie.vote_count || 0) < p.min_votes) return false;
        if (parseInt(movie.release_date.slice(0, 4), 10) < p.min_year) return false;
        if (movie.release_date > dateShift(0)) return false;
        if (p.exclude_genres && genreIds(movie).some(function (g) { return EXCLUDED_GENRES.indexOf(g) >= 0; })) return false;
        return true;
    }

    // ---------- сбор кандидатов ----------

    function shuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }

    function topGenres(weights, count) {
        return Object.keys(weights)
            .filter(function (g) { return weights[g] > 0; })
            .sort(function (a, b) { return weights[b] - weights[a]; })
            .slice(0, count);
    }

    function dislikedGenres(weights) {
        return Object.keys(weights).filter(function (g) { return weights[g] <= -4; });
    }

    function discoverParams(p, extra) {
        var params = {
            sort_by: 'vote_count.desc',
            'vote_average.gte': p.min_rating,
            'vote_count.gte': p.min_votes,
            'primary_release_date.gte': p.min_year + '-01-01',
            'primary_release_date.lte': dateShift(DIGITAL_DELAY_DAYS),
            with_release_type: '4|5', // есть цифровой или физический релиз
            include_adult: 'false',
            page: 1
        };
        var without = p.exclude_genres ? EXCLUDED_GENRES.slice() : [];
        if (extra.without) without = without.concat(extra.without);
        if (without.length) params.without_genres = without.join(',');
        for (var k in extra) if (k !== 'without') params[k] = extra[k];
        return params;
    }

    function collect(profile, p, done) {
        var jobs = [];
        var pool = {};
        var bad = dislikedGenres(profile.weights);

        // 1. рекомендации к понравившимся фильмам
        shuffle(profile.liked.slice()).slice(0, 3).forEach(function (seed) {
            jobs.push({
                url: tmdbUrl('movie/' + seed.id + '/recommendations', { page: 1 }),
                source: { type: 'similar', title: seed.title }
            });
        });

        // 2. любимые жанры
        var fav = topGenres(profile.weights, 3);
        if (fav.length) {
            jobs.push({
                url: tmdbUrl('discover/movie', discoverParams(p, { with_genres: fav.join('|'), without: bad, page: 1 + Math.floor(Math.random() * 5) })),
                source: { type: 'genres' }
            });
        }

        // 3. просто хорошие фильмы — для разнообразия и для «холодного старта»
        jobs.push({
            url: tmdbUrl('discover/movie', discoverParams(p, { without: bad, page: 1 + Math.floor(Math.random() * 10) })),
            source: { type: 'top' }
        });
        jobs.push({
            url: tmdbUrl('discover/movie', discoverParams(p, { sort_by: 'popularity.desc', without: bad, page: 1 + Math.floor(Math.random() * 5) })),
            source: { type: 'top' }
        });

        var left = jobs.length;

        jobs.forEach(function (job) {
            request(job.url, function (json) {
                ((json && json.results) || []).forEach(function (movie) {
                    if (!passesFilters(movie, p) || excluded(movie, profile)) return;
                    var entry = pool[movie.id] || (pool[movie.id] = { movie: movie, sources: [] });
                    entry.sources.push(job.source);
                });
                if (--left === 0) done(rank(pool, profile));
            });
        });
    }

    function rank(pool, profile) {
        var weights = profile.weights;
        var total = 0;
        Object.keys(weights).forEach(function (g) { total += Math.abs(weights[g]); });

        return Object.keys(pool).map(function (id) {
            var entry = pool[id];
            var movie = entry.movie;
            var affinity = 0;

            genreIds(movie).forEach(function (g) { affinity += weights[g] || 0; });
            if (total) affinity = Math.max(-3, Math.min(3, affinity / Math.sqrt(total)));

            var similar = entry.sources.filter(function (s) { return s.type === 'similar'; });

            entry.score = movie.vote_average
                + affinity
                + (similar.length ? 1 + similar.length * 0.5 : 0)
                + Math.log(movie.vote_count) / Math.LN10 * 0.3
                + Math.random() * 1.5;
            entry.reason = similar.length ? 'Похоже на «' + similar[0].title + '»' :
                affinity > 0.5 ? 'В ваших любимых жанрах' : 'Высокий рейтинг';
            return entry;
        }).sort(function (a, b) { return b.score - a.score; });
    }

    // ---------- проверка качества ----------

    function hasDigitalRelease(details) {
        if (details.release_date && details.release_date <= dateShift(365)) return true;
        var countries = (details.release_dates && details.release_dates.results) || [];
        return countries.some(function (c) {
            return (c.release_dates || []).some(function (r) {
                return (r.type === 4 || r.type === 5) && r.release_date && r.release_date.slice(0, 10) <= dateShift(0);
            });
        });
    }

    var GOOD_QUALITY = /2160|1080|4k|uhd|web-?dl|webrip|blu-?ray|bdrip|bdremux|remux/i;
    var BAD_QUALITY = /camrip|\bcam\b|telesync|\bts\b|tsrip|\bhdts\b|telecine|\btc\b|screener|scr\b/i;

    function checkTorrents(details, p, done) {
        var host = p.jacred_url.replace(/\/+$/, '');
        if (!/^https?:\/\//.test(host)) host = 'http://' + host;
        var url = host + '/api/v1.0/torrents?search=' + encodeURIComponent(details.original_title || details.title) +
            '&year=' + (details.release_date || '').slice(0, 4) + '&exact=true';

        request(url, function (json) {
            if (!json || !json.length) return done(json ? false : true); // сеть упала — не блокируем
            done(json.some(function (t) {
                var title = t.title || '';
                if (BAD_QUALITY.test(title)) return false;
                return (t.quality && t.quality >= 1080) || GOOD_QUALITY.test(title);
            }));
        });
    }

    function verify(candidates, p, done, index) {
        index = index || 0;
        if (index >= candidates.length || index >= 8) return done(null);

        var entry = candidates[index];
        request(tmdbUrl('movie/' + entry.movie.id, { append_to_response: 'release_dates' }), function (details) {
            if (!details || !details.id || !hasDigitalRelease(details)) return verify(candidates, p, done, index + 1);
            entry.details = details;
            if (!p.jacred) return done(entry);
            checkTorrents(details, p, function (ok) {
                if (ok) done(entry);
                else verify(candidates, p, done, index + 1);
            });
        });
    }

    // ---------- главное окно ----------

    var busy = false;

    function pick() {
        if (busy) return;

        var data = db();
        if (data.pending && Date.now() - data.pending.time > 60 * 60 * 1000) {
            return askPending(data.pending, pick);
        }

        busy = true;
        Lampa.Loading.start(function () {
            busy = false;
            network.clear();
            Lampa.Loading.stop();
        });

        var p = prefs();
        var profile = buildProfile();

        collect(profile, p, function (candidates) {
            verify(candidates, p, function (entry) {
                if (!busy) return;
                busy = false;
                Lampa.Loading.stop();
                if (!entry) {
                    Lampa.Noty.show('Не нашлось подходящих фильмов. Попробуйте снизить порог рейтинга в настройках.');
                    return;
                }
                show(entry);
            });
        });
    }

    function skip(movie) {
        var data = db();
        data.skipped[movie.id] = Date.now();
        // чистим старые пропуски
        Object.keys(data.skipped).forEach(function (id) {
            if (Date.now() - data.skipped[id] > SKIP_DAYS * DAY) delete data.skipped[id];
        });
        saveDb(data);
    }

    function closeModal() {
        Lampa.Modal.close();
        Lampa.Controller.toggle('content');
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function show(entry) {
        var d = entry.details;
        var year = (d.release_date || '').slice(0, 4);
        var runtime = d.runtime ? Math.floor(d.runtime / 60) + ' ч ' + (d.runtime % 60) + ' мин' : '';
        var genres = (d.genres || []).map(function (g) { return g.name; }).join(', ');
        var poster = d.poster_path ? Lampa.TMDB.image('t/p/w342' + d.poster_path) : '';
        var original = d.original_title && d.original_title !== d.title ? d.original_title : '';

        var html = $(
            '<div class="evening-movie">' +
                (poster ? '<div class="evening-movie__poster"><img src="' + poster + '"></div>' : '') +
                '<div class="evening-movie__info">' +
                    '<div class="evening-movie__title">' + escapeHtml(d.title) + '</div>' +
                    (original ? '<div class="evening-movie__original">' + escapeHtml(original) + '</div>' : '') +
                    '<div class="evening-movie__meta">' +
                        '<span class="evening-movie__rating">★ ' + d.vote_average.toFixed(1) + '</span>' +
                        [year, runtime, escapeHtml(genres)].filter(Boolean).map(function (s) { return '<span>' + s + '</span>'; }).join('') +
                    '</div>' +
                    '<div class="evening-movie__reason">' + escapeHtml(entry.reason) + '</div>' +
                    '<div class="evening-movie__overview">' + escapeHtml(d.overview || 'Описание отсутствует') + '</div>' +
                '</div>' +
            '</div>'
        );

        var card = $.extend({}, entry.movie, d, { source: 'tmdb' });

        Lampa.Modal.open({
            title: 'Фильм на вечер',
            html: html,
            size: 'medium',
            buttons_position: 'outside',
            onBack: closeModal,
            buttons: [
                {
                    name: 'Смотреть',
                    onSelect: function () {
                        var data = db();
                        data.pending = { id: card.id, title: card.title, release_date: card.release_date, genre_ids: genreIds(card), time: Date.now() };
                        saveDb(data);
                        Lampa.Modal.close();
                        Lampa.Activity.push({ url: '', component: 'full', id: card.id, method: 'movie', card: card, source: 'tmdb' });
                    }
                },
                {
                    name: 'Другой',
                    onSelect: function () {
                        skip(card);
                        Lampa.Modal.close();
                        pick();
                    }
                },
                {
                    name: 'Уже смотрел',
                    onSelect: function () {
                        Lampa.Modal.close();
                        rate(card, function () { pick(); }, closeModal);
                    }
                },
                {
                    name: 'Не интересно',
                    onSelect: function () {
                        setStatus(card, 'disliked');
                        Lampa.Modal.close();
                        pick();
                    }
                }
            ]
        });
    }

    // Спросить оценку: понравился / нет / просто просмотрен
    function rate(card, after, cancel, title) {
        var current = getStatus(card.id);
        var items = [
            { title: 'Понравился', status: 'liked' },
            { title: 'Не понравился', status: 'disliked' },
            { title: 'Посмотрел, без оценки', status: 'watched' }
        ];
        items.forEach(function (i) { if (i.status === current) i.selected = true; });
        if (current) items.push({ title: 'Сбросить отметку', status: '' });

        Lampa.Select.show({
            title: title || ('«' + (card.title || card.name) + '»'),
            items: items,
            onSelect: function (item) {
                setStatus(card, item.status);
                Lampa.Noty.show(item.status ? 'Запомнил: ' + item.title.toLowerCase() : 'Отметка удалена');
                after(item.status);
            },
            onBack: cancel
        });
    }

    function askPending(pending, next) {
        var data = db();
        var items = [
            { title: 'Понравился', status: 'liked' },
            { title: 'Не понравился', status: 'disliked' },
            { title: 'Посмотрел, без оценки', status: 'watched' },
            { title: 'Ещё не смотрел', status: 'later' }
        ];
        Lampa.Select.show({
            title: 'Как вам «' + pending.title + '»?',
            items: items,
            onSelect: function (item) {
                if (item.status === 'later') {
                    data.pending.time = Date.now() + 23 * 60 * 60 * 1000; // спросим завтра
                    saveDb(data);
                } else {
                    setStatus(pending, item.status);
                }
                Lampa.Controller.toggle('content');
                next();
            },
            onBack: function () {
                delete data.pending;
                saveDb(data);
                Lampa.Controller.toggle('content');
            }
        });
    }

    // ---------- кнопка в карточке фильма ----------

    var STATUS_TEXT = { liked: 'Нравится', disliked: 'Не нравится', watched: 'Просмотрен' };

    function addFullButton(e) {
        if (e.type !== 'complite') return;
        var movie = e.data && e.data.movie;
        if (!movie || movie.original_name || movie.number_of_seasons) return; // только фильмы

        var render = e.object.activity.render();
        var container = render.find('.full-start-new__buttons, .full-start__buttons').first();
        if (!container.length || container.find('.evening-rate').length) return;

        var button = $(
            '<div class="full-start__button selector evening-rate">' + ICON +
            '<span></span></div>'
        );

        function update() {
            var status = getStatus(movie.id);
            button.find('span').text(STATUS_TEXT[status] || 'Оценить');
        }

        button.on('hover:enter', function () {
            rate(movie, function () {
                update();
                Lampa.Controller.toggle('full_start');
            }, function () {
                Lampa.Controller.toggle('full_start');
            });
        });

        update();
        container.append(button);
    }

    // ---------- пункт меню ----------

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M16 3.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z" fill="currentColor"/></svg>';

    function addMenu() {
        var item = $(
            '<li class="menu__item selector" data-action="evening_movie">' +
                '<div class="menu__ico">' + ICON + '</div>' +
                '<div class="menu__text">Фильм на вечер</div>' +
            '</li>'
        );
        item.on('hover:enter', pick);
        $('.menu .menu__list').eq(0).append(item);
    }

    function addStyles() {
        $('body').append('<style id="evening-movie-style">' +
            '.evening-movie{display:flex;gap:1.5em;align-items:flex-start}' +
            '.evening-movie__poster{flex:0 0 13em}' +
            '.evening-movie__poster img{width:100%;border-radius:.6em;display:block}' +
            '.evening-movie__info{flex:1;min-width:0}' +
            '.evening-movie__title{font-size:1.8em;font-weight:600;line-height:1.2}' +
            '.evening-movie__original{opacity:.6;margin-top:.2em}' +
            '.evening-movie__meta{display:flex;flex-wrap:wrap;gap:.4em 1em;margin-top:.8em;opacity:.85}' +
            '.evening-movie__rating{color:#ffd54a;font-weight:600}' +
            '.evening-movie__reason{display:inline-block;margin-top:.8em;padding:.25em .7em;border-radius:1em;background:rgba(255,255,255,.12);font-size:.9em}' +
            '.evening-movie__overview{margin-top:1em;line-height:1.5;opacity:.9}' +
            '.evening-rate svg{width:1.6em;height:1.6em}' +
            '@media (max-width:600px){.evening-movie{flex-direction:column}.evening-movie__poster{flex-basis:auto;width:9em}}' +
            '</style>');
    }

    function start() {
        addStyles();
        addMenu();
        addSettings();
        Lampa.Listener.follow('full', addFullButton);
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
