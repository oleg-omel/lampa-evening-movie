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
    //
    // evening_movie_items — оценки: {id: {id, title, year, genres, status, time}}.
    //   Синхронизируется через аккаунт CUB (нужен CUB Premium). Сброс оценки не удаляет
    //   запись, а ставит status: '' — удаления Lampa между устройствами передаёт ненадёжно.
    // evening_movie_db — только локальное: пропущенные фильмы и «как вам фильм?».
    // Кроме того, оценки дублируются в родные закладки Lampa — они синхронизируются бесплатно.

    var ITEMS_KEY = 'evening_movie_items';
    var UPLOADED_KEY = 'evening_movie_uploaded';

    function db() {
        var data = Lampa.Storage.get(DB_KEY, '{}');
        if (!data || typeof data !== 'object') data = {};
        data.skipped = data.skipped || {}; // id -> timestamp
        return data;
    }

    function saveDb(data) {
        Lampa.Storage.set(DB_KEY, data);
    }

    function ratings() {
        var items = Lampa.Storage.get(ITEMS_KEY, '{}');
        return items && typeof items === 'object' && !Array.isArray(items) ? items : {};
    }

    function rated(items, id) {
        return items[id] && items[id].status ? items[id] : null;
    }

    function setStatus(movie, status) {
        var items = ratings();
        items[movie.id] = {
            id: movie.id,
            title: movie.title || movie.name,
            year: (movie.release_date || '').slice(0, 4),
            genres: genreIds(movie),
            status: status || '',
            time: Date.now()
        };
        Lampa.Storage.set(ITEMS_KEY, items);

        var data = db();
        if (data.pending && data.pending.id == movie.id) {
            delete data.pending;
            saveDb(data);
        }

        applyNativeMarks(movie, status);
    }

    // Оценка плагина, а если её нет — родные отметки Lampa (могли прийти с другого устройства)
    function getStatus(card) {
        var item = rated(ratings(), card.id);
        if (item) return item.status;
        var marks = lampaMarks(card);
        if (marks.like) return 'liked';
        if (marks.thrown) return 'disliked';
        if (marks.viewed) return 'watched';
        return '';
    }

    // Родные закладки: понравился → «Нравится» + «Просмотрено», просмотрен → «Просмотрено»,
    // не понравился → «Брошено». «Просмотрено» и «Брошено» в Lampa взаимоисключающие.
    function applyNativeMarks(movie, status) {
        try {
            var card = nativeCard(movie);
            var marks = lampaMarks(card);
            var mark = status === 'disliked' ? 'thrown' : status ? 'viewed' : '';
            var like = status === 'liked';

            if (like && !marks.like) Lampa.Favorite.add('like', card);
            if (!like && marks.like) Lampa.Favorite.remove('like', card);

            ['look', 'viewed', 'scheduled', 'continued', 'thrown'].forEach(function (m) {
                if (marks[m] && m !== mark && (mark || m === 'viewed' || m === 'thrown')) Lampa.Favorite.remove(m, card);
            });
            if (mark && !marks[mark]) Lampa.Favorite.add(mark, card);
        } catch (e) {
            console.log('Evening movie', 'native marks', e.message);
        }
    }

    // Карточка в том виде, в каком её хранит Lampa в закладках
    function nativeCard(movie) {
        var card = {};
        ['id', 'title', 'original_title', 'poster_path', 'backdrop_path', 'release_date', 'vote_average', 'overview', 'original_language']
            .forEach(function (k) { if (movie[k] !== undefined) card[k] = movie[k]; });
        card.genre_ids = genreIds(movie);
        card.source = 'tmdb';
        return card;
    }

    // Перенос оценок из первой версии плагина (лежали внутри evening_movie_db)
    function migrate() {
        var data = Lampa.Storage.get(DB_KEY, '{}');
        if (!data || !data.items) return;
        var items = ratings();
        Object.keys(data.items).forEach(function (id) {
            if (!items[id]) items[id] = data.items[id];
        });
        delete data.items;
        Lampa.Storage.set(ITEMS_KEY, items);
        saveDb(data);
    }

    // Синхронизация через CUB. Lampa отправляет на сервер только записи, изменённые после
    // загрузки данных с сервера, поэтому старые локальные оценки один раз «освежаем»
    // небольшими порциями (у Lampa ограничение — 5 отправок за 2 секунды).
    function enableSync() {
        if (!Lampa.Storage.sync) return;
        Lampa.Storage.sync(ITEMS_KEY, 'object_object');

        Lampa.Listener.follow('worker_storage', function (e) {
            if (e.type !== 'insert' || e.name !== ITEMS_KEY) return;
            if (Lampa.Storage.get(UPLOADED_KEY, false)) return;

            var server = e.from || {};
            var queue = Object.keys(ratings()).filter(function (id) { return !server[id]; });

            function next() {
                if (!queue.length) return Lampa.Storage.set(UPLOADED_KEY, true);
                var items = ratings();
                queue.splice(0, 4).forEach(function (id) {
                    if (items[id]) items[id].time = Date.now();
                });
                Lampa.Storage.set(ITEMS_KEY, items);
                setTimeout(next, 2500);
            }

            setTimeout(next, 1000);
        });
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
                            var items = ratings();
                            Object.keys(items).forEach(function (id) {
                                if (items[id].status) { applyNativeMarks(items[id], ''); items[id] = { id: items[id].id, title: items[id].title, status: '', time: Date.now() }; }
                            });
                            Lampa.Storage.set(ITEMS_KEY, items);
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

    var MARK_TYPES = ['like', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];

    // Отметки карточки; при входе в CUB они лежат в облачных закладках, а не в Favorite
    function lampaMarks(card) {
        try {
            var account = Lampa.Account;
            if (account && account.Permit && account.Permit.sync && account.Bookmarks && account.Bookmarks.find) {
                var result = {};
                MARK_TYPES.forEach(function (type) {
                    result[type] = Boolean(account.Bookmarks.find({ type: type, id: card.id }));
                });
                return result;
            }
            return Lampa.Favorite.check(card) || {};
        } catch (e) {
            return {};
        }
    }

    function lampaWatchedPercent(card) {
        try { return card.original_title ? Lampa.Timeline.watched(card) || 0 : 0; } catch (e) { return 0; }
    }

    // Профиль: веса жанров + фильмы-«семена» для рекомендаций
    function buildProfile() {
        var data = db();
        var items = ratings();
        var weights = {};
        var liked = [];
        var seen = {};

        function add(genres, w) {
            (genres || []).forEach(function (g) { weights[g] = (weights[g] || 0) + w; });
        }

        Object.keys(items).forEach(function (id) {
            var item = items[id];
            if (item.status === 'liked') { add(item.genres, 2); liked.push(item); }
            else if (item.status === 'disliked') add(item.genres, -2);
            else if (item.status === 'watched') add(item.genres, 0.3);
        });

        // родные отметки Lampa тоже учитываем
        lampaList('like').forEach(function (card) {
            if (!rated(items, card.id)) { add(genreIds(card), 1.5); liked.push({ id: card.id, title: card.title }); }
            seen[card.id] = true;
        });
        lampaList('viewed').forEach(function (card) {
            if (!rated(items, card.id)) add(genreIds(card), 0.3);
            seen[card.id] = true;
        });
        lampaList('thrown').forEach(function (card) {
            if (!rated(items, card.id)) add(genreIds(card), -1.5);
            seen[card.id] = true;
        });

        return { weights: weights, liked: liked, seen: seen, data: data, items: items };
    }

    function excluded(movie, profile) {
        if (rated(profile.items, movie.id) || profile.seen[movie.id]) return true;
        var skipped = profile.data.skipped[movie.id];
        if (skipped && Date.now() - skipped < SKIP_DAYS * DAY) return true;
        var marks = lampaMarks(movie);
        if (marks.viewed || marks.thrown) return true;
        if (lampaWatchedPercent(movie) >= 70) return true;
        return false;
    }

    // ---------- режимы и фильтры ----------

    var MOODS = [
        { id: 'laugh', title: 'Посмеяться', genres: [35], without: [27, 53, 10752] },
        { id: 'cozy', title: 'Уютно и спокойно', genres: [35, 10749, 10751], without: [27, 53, 80, 10752] },
        { id: 'romance', title: 'Романтика', genres: [10749], without: [27] },
        { id: 'drive', title: 'Драйв и экшен', genres: [28, 12], without: [] },
        { id: 'thrill', title: 'Пощекотать нервы', genres: [53, 27, 9648], without: [35, 10751] },
        { id: 'crime', title: 'Детектив и криминал', genres: [80, 9648], without: [10751] },
        { id: 'think', title: 'Подумать', genres: [18, 9648, 878], without: [35, 10751, 28], min_rating: 7.5 },
        { id: 'touch', title: 'Что-то трогательное', genres: [18, 10749], without: [27, 28, 53] },
        { id: 'worlds', title: 'Другие миры', genres: [878, 14], without: [] },
        { id: 'history', title: 'История и война', genres: [36, 10752], without: [] }
    ];

    var GENRES = [
        [28, 'Боевик'], [12, 'Приключения'], [35, 'Комедия'], [18, 'Драма'], [80, 'Криминал'],
        [9648, 'Детектив'], [53, 'Триллер'], [27, 'Ужасы'], [878, 'Фантастика'], [14, 'Фэнтези'],
        [10749, 'Мелодрама'], [10751, 'Семейный'], [36, 'История'], [10752, 'Военный'],
        [37, 'Вестерн'], [10402, 'Музыка'], [16, 'Мультфильм'], [99, 'Документальный']
    ];

    var DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

    function findMood(id) {
        return MOODS.filter(function (m) { return m.id === id; })[0];
    }

    function genreName(id) {
        var g = GENRES.filter(function (g) { return g[0] == id; })[0];
        return g ? g[1] : '';
    }

    function decadeName(year) {
        return year >= 2000 ? year + '-е' : String(year).slice(2) + '-е';
    }

    function describeFilter(f) {
        var parts = [];
        if (f.mood && findMood(f.mood)) parts.push(findMood(f.mood).title);
        if (f.genre) parts.push(genreName(f.genre));
        if (f.decade) parts.push(decadeName(f.decade));
        return parts.join(', ');
    }

    // Режим -> конкретные ограничения поиска
    function criteria(mode, p) {
        var f = mode.type === 'custom' ? mode.filter : {};
        var mood = findMood(f.mood);
        var genre = f.genre ? parseInt(f.genre, 10) : 0;
        var exclude = p.exclude_genres ? EXCLUDED_GENRES.slice() : [];
        var without = (mood ? mood.without : []).concat(exclude).filter(function (g) { return g !== genre; });

        return {
            from: f.decade ? Math.max(f.decade, 1900) : p.min_year,
            to: f.decade ? f.decade + 9 : 0,
            genre: genre,                          // обязательный жанр
            any: mood && !genre ? mood.genres : [], // хотя бы один из жанров настроения
            boost: mood ? mood.genres : [],         // жанры настроения поднимают в рейтинге
            without: without,
            min_rating: Math.max(p.min_rating, (mood && mood.min_rating) || 0)
        };
    }

    function passesFilters(movie, p, c) {
        if (!movie || !movie.id || movie.adult || movie.video) return false;
        if (!movie.poster_path || !movie.release_date) return false;
        if ((movie.vote_average || 0) < c.min_rating) return false;
        if ((movie.vote_count || 0) < p.min_votes) return false;
        var year = parseInt(movie.release_date.slice(0, 4), 10);
        if (year < c.from || (c.to && year > c.to)) return false;
        if (movie.release_date > dateShift(0)) return false;
        var genres = genreIds(movie);
        if (c.genre && genres.indexOf(c.genre) < 0) return false;
        if (c.any.length && !genres.some(function (g) { return c.any.indexOf(g) >= 0; })) return false;
        if (genres.some(function (g) { return c.without.indexOf(g) >= 0; })) return false;
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
        return Object.keys(weights).filter(function (g) { return weights[g] <= -4; }).map(Number);
    }

    function discoverParams(p, c, extra) {
        var params = {
            sort_by: 'vote_count.desc',
            'vote_average.gte': c.min_rating,
            'vote_count.gte': p.min_votes,
            'primary_release_date.gte': c.from + '-01-01',
            'primary_release_date.lte': c.to && c.to < new Date().getFullYear() ? c.to + '-12-31' : dateShift(DIGITAL_DELAY_DAYS),
            with_release_type: '4|5', // есть цифровой или физический релиз
            include_adult: 'false',
            page: 1
        };
        if (c.genre) params.with_genres = String(c.genre);
        else if (c.any.length) params.with_genres = c.any.join('|');
        var without = c.without.concat(extra.without || []).filter(function (g) { return g !== c.genre && c.any.indexOf(g) < 0; });
        if (without.length) params.without_genres = without.join(',');
        for (var k in extra) if (k !== 'without') params[k] = extra[k];
        return params;
    }

    // Запрашивает несколько случайных страниц выдачи discover
    function discoverRandom(params, pages, done) {
        request(tmdbUrl('discover/movie', params), function (json) {
            var first = (json && json.results) || [];
            var total = Math.min((json && json.total_pages) || 1, 500);
            if (total <= 1) return done(first);

            var numbers = [];
            for (var i = 1; i <= total; i++) numbers.push(i);
            numbers = shuffle(numbers).slice(0, pages);

            var all = [];
            var left = numbers.length;
            numbers.forEach(function (page) {
                if (page === 1) {
                    all = all.concat(first);
                    if (--left === 0) done(all);
                    return;
                }
                request(tmdbUrl('discover/movie', $.extend({}, params, { page: page })), function (res) {
                    all = all.concat((res && res.results) || []);
                    if (--left === 0) done(all.length ? all : first);
                });
            });
        });
    }

    function collect(profile, p, mode, c, done) {
        var jobs = [];
        var pool = {};
        var bad = mode.type === 'random' ? [] : dislikedGenres(profile.weights);

        function add(results, source) {
            results.forEach(function (movie) {
                if (!passesFilters(movie, p, c) || excluded(movie, profile)) return;
                var entry = pool[movie.id] || (pool[movie.id] = { movie: movie, sources: [] });
                entry.sources.push(source);
            });
        }

        function listJob(url, source) {
            jobs.push(function (next) {
                request(url, function (json) { add((json && json.results) || [], source); next(); });
            });
        }

        function randomJob(params, pages, source) {
            jobs.push(function (next) {
                discoverRandom(params, pages, function (results) { add(results, source); next(); });
            });
        }

        if (mode.type === 'random') {
            var sorts = ['vote_count.desc', 'popularity.desc', 'vote_average.desc', 'revenue.desc'];
            randomJob(discoverParams(p, c, { sort_by: sorts[Math.floor(Math.random() * sorts.length)] }), 2, { type: 'random' });
            randomJob(discoverParams(p, c, { sort_by: 'primary_release_date.desc' }), 1, { type: 'random' });
        } else {
            // рекомендации к понравившимся фильмам (в режиме фильтров тоже, но отсеются по фильтру)
            shuffle(profile.liked.slice()).slice(0, mode.type === 'custom' ? 4 : 3).forEach(function (seed) {
                listJob(tmdbUrl('movie/' + seed.id + '/recommendations', { page: 1 }), { type: 'similar', title: seed.title });
            });

            if (mode.type === 'custom') {
                randomJob(discoverParams(p, c, { without: bad }), 2, { type: 'filter' });
                randomJob(discoverParams(p, c, { sort_by: 'popularity.desc', without: bad }), 1, { type: 'filter' });
            } else {
                var fav = topGenres(profile.weights, 3);
                if (fav.length) {
                    listJob(tmdbUrl('discover/movie', discoverParams(p, c, { with_genres: fav.join('|'), without: bad, page: 1 + Math.floor(Math.random() * 5) })), { type: 'genres' });
                }
                // просто хорошие фильмы — для разнообразия и для «холодного старта»
                listJob(tmdbUrl('discover/movie', discoverParams(p, c, { without: bad, page: 1 + Math.floor(Math.random() * 10) })), { type: 'top' });
                listJob(tmdbUrl('discover/movie', discoverParams(p, c, { sort_by: 'popularity.desc', without: bad, page: 1 + Math.floor(Math.random() * 5) })), { type: 'top' });
            }
        }

        var left = jobs.length;
        jobs.forEach(function (job) {
            job(function () {
                if (--left === 0) done(rank(pool, profile, mode, c));
            });
        });
    }

    function rank(pool, profile, mode, c) {
        var weights = profile.weights;
        var total = 0;
        Object.keys(weights).forEach(function (g) { total += Math.abs(weights[g]); });

        return Object.keys(pool).map(function (id) {
            var entry = pool[id];
            var movie = entry.movie;

            if (mode.type === 'random') {
                entry.score = Math.random();
                entry.reason = 'Случайный выбор';
                return entry;
            }

            var affinity = 0;
            genreIds(movie).forEach(function (g) { affinity += weights[g] || 0; });
            if (total) affinity = Math.max(-3, Math.min(3, affinity / Math.sqrt(total)));

            var mood = genreIds(movie).filter(function (g) { return c.boost.indexOf(g) >= 0; }).length;
            var similar = entry.sources.filter(function (s) { return s.type === 'similar'; });

            entry.score = movie.vote_average
                + affinity
                + (similar.length ? 1 + similar.length * 0.5 : 0)
                + mood * 0.5
                + Math.log(movie.vote_count) / Math.LN10 * 0.3
                + Math.random() * (mode.type === 'custom' ? 2.5 : 1.5);
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
    var FILTER_KEY = 'evening_movie_filter';

    function savedFilter() {
        var f = Lampa.Storage.get(FILTER_KEY, '{}');
        return f && typeof f === 'object' ? f : {};
    }

    // Первый экран: выбор режима
    function openModes() {
        if (busy) return;

        var data = db();
        if (data.pending && Date.now() - data.pending.time > 60 * 60 * 1000) {
            return askPending(data.pending, openModes);
        }

        var filter = describeFilter(savedFilter());

        Lampa.Select.show({
            title: 'Фильм на вечер',
            items: [
                { title: 'По моему вкусу', subtitle: 'С учётом ваших оценок', mode: { type: 'taste' } },
                { title: 'Случайный фильм', subtitle: 'Любой хороший фильм, без учёта вкуса', mode: { type: 'random' } },
                { title: 'Настроение, жанр, десятилетие', subtitle: filter ? 'В прошлый раз: ' + filter : 'Указать, чего хочется', filters: true }
            ],
            onSelect: function (item) {
                if (item.filters) openFilters(savedFilter());
                else {
                    Lampa.Controller.toggle('content');
                    pick(item.mode);
                }
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function chooseOption(title, items, current, done, back) {
        items.forEach(function (i) { i.selected = String(i.value || '') === String(current || ''); });
        Lampa.Select.show({
            title: title,
            items: items,
            onSelect: function (item) { done(item.value || ''); },
            onBack: back
        });
    }

    // Экран фильтров: каждое поле открывает свой список, «Подобрать» запускает поиск
    function openFilters(f) {
        var mood = findMood(f.mood);
        var reopen = function () { openFilters(f); };

        function set(key) {
            return function (value) {
                f[key] = value;
                Lampa.Storage.set(FILTER_KEY, f);
                openFilters(f);
            };
        }

        var items = [
            { title: 'Настроение', subtitle: mood ? mood.title : 'Любое', action: 'mood' },
            { title: 'Жанр', subtitle: f.genre ? genreName(f.genre) : 'Любой', action: 'genre' },
            { title: 'Десятилетие', subtitle: f.decade ? decadeName(f.decade) : 'Любое', action: 'decade' }
        ];
        if (describeFilter(f)) items.push({ title: 'Сбросить фильтры', action: 'reset' });
        items.push({ title: 'Подобрать фильм', subtitle: describeFilter(f) || 'Без ограничений', action: 'go' });

        Lampa.Select.show({
            title: 'Чего хочется?',
            items: items,
            onSelect: function (item) {
                if (item.action === 'mood') {
                    chooseOption('Настроение', [{ title: 'Любое' }].concat(MOODS.map(function (m) { return { title: m.title, value: m.id }; })), f.mood, set('mood'), reopen);
                } else if (item.action === 'genre') {
                    chooseOption('Жанр', [{ title: 'Любой' }].concat(GENRES.map(function (g) { return { title: g[1], value: g[0] }; })), f.genre, set('genre'), reopen);
                } else if (item.action === 'decade') {
                    chooseOption('Десятилетие', [{ title: 'Любое' }].concat(DECADES.map(function (d) { return { title: decadeName(d), value: d }; }).reverse()), f.decade, set('decade'), reopen);
                } else if (item.action === 'reset') {
                    f = {};
                    Lampa.Storage.set(FILTER_KEY, f);
                    openFilters(f);
                } else {
                    Lampa.Controller.toggle('content');
                    pick({ type: 'custom', filter: f });
                }
            },
            onBack: openModes
        });
    }

    function pick(mode) {
        if (busy) return;
        busy = true;
        Lampa.Loading.start(function () {
            busy = false;
            network.clear();
            Lampa.Loading.stop();
        });

        var p = prefs();
        var profile = buildProfile();

        collect(profile, p, mode, criteria(mode, p), function (candidates) {
            verify(candidates, p, function (entry) {
                if (!busy) return;
                busy = false;
                Lampa.Loading.stop();
                if (!entry) {
                    if (mode.type === 'custom') {
                        Lampa.Noty.show('Под эти условия ничего не нашлось — попробуйте ослабить фильтры');
                        openFilters(mode.filter);
                    } else {
                        Lampa.Noty.show('Не нашлось подходящих фильмов. Попробуйте снизить порог рейтинга в настройках.');
                    }
                    return;
                }
                show(entry, mode);
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

    var MODE_TITLE = { taste: 'По вашему вкусу', random: 'Случайный фильм' };

    function show(entry, mode) {
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
            title: 'Фильм на вечер · ' + (mode.type === 'custom' ? describeFilter(mode.filter) || 'Без фильтров' : MODE_TITLE[mode.type]),
            html: html,
            size: 'medium',
            buttons_position: 'outside',
            onBack: closeModal,
            buttons: [
                {
                    name: 'Смотреть',
                    onSelect: function () {
                        var data = db();
                        data.pending = $.extend(nativeCard(card), { time: Date.now() });
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
                        pick(mode);
                    }
                },
                {
                    name: 'Уже смотрел',
                    onSelect: function () {
                        Lampa.Modal.close();
                        rate(card, function () { pick(mode); }, closeModal);
                    }
                },
                {
                    name: 'Не интересно',
                    onSelect: function () {
                        setStatus(card, 'disliked');
                        Lampa.Modal.close();
                        pick(mode);
                    }
                }
            ]
        });
    }

    // Спросить оценку: понравился / нет / просто просмотрен
    function rate(card, after, cancel, title) {
        var current = getStatus(card);
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
            var status = getStatus(movie);
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
        item.on('hover:enter', openModes);
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
        migrate();
        enableSync();
        addStyles();
        addMenu();
        addSettings();
        Lampa.Listener.follow('full', addFullButton);
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
