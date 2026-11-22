
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <algorithm>

#include "targetver.h"

#include <fcntl.h>
#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wignored-attributes"
#endif
#include <mmintrin.h>
#ifdef __clang__
#pragma clang diagnostic pop
#endif
#include <io.h>
#include <process.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/stat.h>
#include <tchar.h>
#include <time.h>
#include <wchar.h>
#ifdef _OPENMP
#include <omp.h>
#endif

#include <algorithm>
#if defined(_MSC_VER) && _MSC_VER >= 1800  // We don't check _CPPLIB_VER here, because we want to use the <atomic> that came with the compiler, even if we use a different STL
#define is_trivially_copyable_v sizeof is_trivially_copyable
#include <atomic>
#undef  is_trivially_copyable_v
#endif
#if defined(_CPPLIB_VER) && _CPPLIB_VER >= 610
#include <mutex>
#endif
#ifndef assert
#include <cassert>
#endif
#include <map>
#include <fstream>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include <Windows.h>
#include <Dbt.h>
#include <muiload.h>
#include <ProvExce.h>
#include <ShlObj.h>
#ifndef ILIsEmpty
inline BOOL ILIsEmpty(LPCITEMIDLIST pidl) { return ((pidl == NULL) || (pidl->mkid.cb==0)); }
#endif
#include <WinNLS.h>

#include "nformat.hpp"
#include "path.hpp"

#include "NtUserCallHook.hpp"
#include "string_matcher.hpp"

#include "resource.h"

#ifdef __clang__
#ifndef _CPPLIB_VER
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wextra-qualification"  // for _Fpz
namespace std { fpos_t const std::_Fpz = { 0 }; }
#pragma clang diagnostic pop
#endif
EXTERN_C const GUID DECLSPEC_SELECTANY IID_IShellFolder = { 0x000214E6L, 0, 0, { 0xC0, 0, 0, 0, 0, 0, 0, 0x46 } };
#endif



template<class T, class Traits = std::char_traits<T>, class Ax = std::allocator<T> >
class basic_vector_based_string : public
#ifdef _DEBUG
	std::basic_string<T, Traits, Ax>
#else
	std::vector<T, Ax>
#endif
{
	typedef basic_vector_based_string this_type;
	typedef std::basic_string<T, Traits, Ax> string_type;
	typedef
#ifdef _DEBUG
		string_type
#else
		std::vector<T, Ax>
#endif
		base_type;
public:
	typedef typename base_type::size_type size_type;
	typedef typename base_type::allocator_type allocator_type;
	typedef typename base_type::value_type const *const_pointer;
	typedef typename base_type::value_type value_type;
	static size_type const npos = ~size_type();
	basic_vector_based_string() : base_type() { }
	explicit basic_vector_based_string(const_pointer const value, size_t const n = npos) : base_type(value, value + static_cast<ptrdiff_t>(n == npos ? Traits::length(value) : n)) { }
	explicit basic_vector_based_string(size_type const n) : base_type(n) { }
	explicit basic_vector_based_string(size_type const n, value_type const &value) : base_type(n, value) { }
	explicit basic_vector_based_string(allocator_type const &ax) : base_type(ax) { }
	explicit basic_vector_based_string(size_type const n, allocator_type const &ax) : base_type(n, ax) { }
	explicit basic_vector_based_string(size_type const n, value_type const &value, allocator_type const &ax) : base_type(n, value, ax) { }
	using base_type::insert;
	using base_type::operator =;
#ifndef _DEBUG
	typedef Traits traits_type;
	typedef typename base_type::difference_type difference_type;
	typedef typename base_type::iterator iterator;
	typedef typename base_type::const_iterator const_iterator;
	using base_type::erase;
	void append(size_t const n, value_type const &value)
	{
		if (!n) { return; }
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
		if (this->_End - this->_Last < static_cast<ptrdiff_t>(n))
		{
			this->reserve(this->size() + n);
			for (size_t i = 0; i != n; ++i)
			{
				this->push_back(value);
			}
		}
		else
		{
			std::uninitialized_fill(this->_Last, this->_Last + static_cast<ptrdiff_t>(n), value);
			this->_Last += n;
		}
#else
		this->reserve(this->size() + n);
		for (size_t i = 0; i != n; ++i)
		{
			this->push_back(value);
		}
#endif
	}
	void append(const_pointer const begin, const_pointer const end)
	{
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
		ptrdiff_t const n = end - begin;
		if (this->_End - this->_Last < n)
		{
			this->insert(this->end(), begin, end);
		}
		else
		{
			std::uninitialized_copy(begin, end, this->_Last);
			this->_Last += n;
		}
#else
		this->insert(this->end(), begin, end);
#endif
	}
	void append(const_pointer const value, size_type n = npos) { return this->append(value, value + static_cast<ptrdiff_t>(n == npos ? Traits::length(value) : n)); }
	size_type find(value_type const &value, size_type const offset = 0) const { const_iterator begin = this->begin() + static_cast<difference_type>(offset), end = this->end(); size_type result = static_cast<size_type>(std::find(begin, end, value) - begin); if (result >= static_cast<size_type>(end - begin)) { result = npos; } else { result += offset; } return result; }
	const_pointer c_str() { const_pointer p; size_t const n = this->size(); if (n == 0 || this->capacity() <= n || *(&*this->begin() + static_cast<ptrdiff_t>(n)) != value_type()) { this->push_back(value_type()); p = &*this->begin(); this->pop_back(); } else { p = &*this->begin(); } return p; }
	const_pointer data() const { return this->empty() ? NULL :&*this->begin(); }
	iterator erase(size_t const pos, size_type const n = npos)
	{ return this->erase(this->begin() + static_cast<difference_type>(pos), this->begin() + static_cast<difference_type>(pos) + (n == npos ? this->size() - pos : n)); }
	iterator insert(size_t const pos, const_pointer const value, size_type const n = npos)
	{ return this->insert(this->begin() + static_cast<difference_type>(pos), value, n); }
	this_type operator +(base_type const &other) const { this_type result; result.reserve(this->size() + other.size()); result += *this; result += other; return result; }
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
	void push_back(value_type const &value)
	{
		if (this->_Last != this->_End)
		{
			this->allocator.construct(this->_Last, value);
			++this->_Last;
		}
		else
		{
			this->base_type::push_back(value);
		}
	}
#endif
	friend this_type operator +(const_pointer const left, base_type const &right) { size_t const nleft = Traits::length(left); this_type result; result.reserve(nleft + right.size()); result.append(left, nleft); result += right; return result; }
	this_type &operator+=(base_type const &value) { if (!value.empty()) { this->append(&*value.begin(), &*(value.end() - 1) + 1); } return *this; }
#else
	using base_type::operator+=;
	this_type &operator+=(this_type const &value) { if (!value.empty()) { this->append(&*value.begin(), &*(value.end() - 1) + 1); } return *this; }
#endif
	template<class Ax2>
	friend std::basic_string<T, Traits, Ax2> &operator+=(std::basic_string<T, Traits, Ax2> &out, this_type const &me) { out.append(me.begin(), me.end()); return out; }
	iterator insert(iterator const i, const_pointer const value, size_type const n = npos)
	{ size_type const pos = static_cast<size_type>(i - this->begin()); this->insert(i, value, value + static_cast<ptrdiff_t>(n == npos ? Traits::length(value) : n)); return this->begin() + static_cast<difference_type>(pos); }
	this_type &operator =(const_pointer const value) { this->clear(); this->append(value); return *this; }
};

template<class It, class Less>
bool is_sorted_ex(It begin, It const end, Less less, bool const reversed = false)
{
	if (begin != end)
	{
		It i(begin);
		It const &left = reversed ? i : begin, &right = reversed ? begin : i;
		++i;
		while (i != end)
		{
			if (less(*right, *left))
			{
				return false;
			}
			begin = i;
			++i;
		}
	}
	return true;
}

template<class ValueType, class KeyComp>
struct stable_sort_by_key_comparator : KeyComp
{
	explicit stable_sort_by_key_comparator(KeyComp const &comp = KeyComp()) : KeyComp(comp) { }
	typedef ValueType value_type;
	bool operator()(value_type const &a, value_type const &b) const
	{
		return this->KeyComp::operator()(a.first, b.first) || (!this->KeyComp::operator()(b.first, a.first) && (a.second < b.second));
	}
};

template<class It, class Key, class Swapper>
void stable_sort_by_key(It begin, It end, Key key, Swapper swapper)
{
	typedef typename std::iterator_traits<It>::difference_type Diff;
	typedef std::less<typename Key::result_type> KeyComp;
	typedef std::vector<std::pair<typename Key::result_type, Diff> > Keys;
	Keys keys;
	Diff const n = std::distance(begin, end);
	keys.reserve(static_cast<typename Keys::size_type>(n));
	{
		Diff j = 0;
		for (It i = begin; i != end; ++i)
		{ keys.push_back(typename Keys::value_type(key(*i), j++)); }
	}
	std::stable_sort(keys.begin(), keys.end(), stable_sort_by_key_comparator<typename Keys::value_type, KeyComp>());
	for (Diff i = 0; i != n; ++i)
	{
		for (Diff j = i; ; )
		{
			using std::swap;
			swap(j, keys[j].second);
			swapper(*(begin + j), *(begin + j));
			if (j == i) { break; }
			using std::iter_swap;
			swapper(*(begin + j), *(begin + keys[j].second));
		}
	}
}

class DynamicAllocator
{
protected:
	~DynamicAllocator() { }
public:
	typedef void *pointer;
	typedef void const *const_pointer;
	virtual void deallocate(pointer const p, size_t const n) = 0;
	virtual pointer allocate(size_t const n, pointer const hint = NULL) = 0;
	virtual pointer reallocate(pointer const p, size_t const n, bool const allow_movement) = 0;
};

template<class T>
class dynamic_allocator : private std::allocator<T>
{
	typedef dynamic_allocator this_type;
	typedef std::allocator<T> base_type;
	typedef DynamicAllocator dynamic_allocator_type;
	dynamic_allocator_type *_alloc;  /* Keep this IMMUTABLE, since otherwise we need to share state via heap allocation */
public:
	typedef typename base_type::value_type value_type;
	typedef typename base_type::const_pointer const_pointer;
	typedef typename base_type::const_reference const_reference;
	typedef typename base_type::difference_type difference_type;
	typedef typename base_type::pointer pointer;
	typedef typename base_type::reference reference;
	typedef typename base_type::size_type size_type;
	dynamic_allocator() : base_type(), _alloc() { }
	explicit dynamic_allocator(dynamic_allocator_type *const alloc) : base_type(), _alloc(alloc) { }
	template<class U>
	dynamic_allocator(dynamic_allocator<U> const &other) : base_type(other.base()), _alloc(other.dynamic_alloc()) { }
	template<class U>
	struct rebind { typedef dynamic_allocator<U> other; };
	dynamic_allocator_type *dynamic_alloc() const { return this->_alloc; }
	base_type &base() { return static_cast<base_type &>(*this); }
	base_type const &base() const { return static_cast<base_type const &>(*this); }
	pointer allocate(size_type const n, void *const p = NULL) { pointer r; if (this->_alloc) { r = static_cast<pointer>(this->_alloc->allocate(n * sizeof(value_type), static_cast<typename dynamic_allocator_type::pointer>(p))); } else { r = this->base_type::allocate(n, p); } return r; }
	void deallocate(pointer const p, size_type const n) { if (this->_alloc) { this->_alloc->deallocate(p, n * sizeof(value_type)); } else { this->base_type::deallocate(p, n); } }
	pointer reallocate(pointer const p, size_t const n, bool const allow_movement) { if (this->_alloc) { return static_cast<pointer>(this->_alloc->reallocate(p, n * sizeof(value_type), allow_movement)); } else { return NULL; } }
	bool operator==(this_type const &other) const { return static_cast<base_type const &>(*this) == static_cast<base_type const &>(other); }
	bool operator!=(this_type const &other) const { return static_cast<base_type const &>(*this) != static_cast<base_type const &>(other); }
	template<class U>
	this_type &operator =(dynamic_allocator<U> const &other) { return static_cast<this_type &>(this->base_type::operator =(other.base())); }
	
	using base_type::construct;
	using base_type::destroy;
	using base_type::address;
	using base_type::max_size;
};

class SingleMovableGlobalAllocator : public DynamicAllocator
{
	SingleMovableGlobalAllocator(SingleMovableGlobalAllocator const &);
	SingleMovableGlobalAllocator &operator =(SingleMovableGlobalAllocator const &);
	HGLOBAL _recycled;
public:
	~SingleMovableGlobalAllocator() { if (this->_recycled) { GlobalFree(this->_recycled); this->_recycled = NULL; } }
	SingleMovableGlobalAllocator() : _recycled() { }
	bool disown(HGLOBAL const h) { bool const same = h == this->_recycled; if (same) { this->_recycled = NULL; } return same; }
	void deallocate(pointer const p, size_t const n)
	{
		if (n)
		{
			if (HGLOBAL const h = GlobalHandle(p))
			{
				GlobalUnlock(h);
				if (!this->_recycled)
				{
					this->_recycled = h;
				}
				else
				{
					GlobalFree(h);
				}
			}
		}
	}
	pointer allocate(size_t const n, pointer const hint = NULL)
	{
		HGLOBAL mem = NULL;
		if (n)
		{
			if (this->_recycled)
			{
				mem = GlobalReAlloc(this->_recycled, n, GMEM_MOVEABLE);
				if (mem) { this->_recycled = NULL; }
			}
			if (!mem) { mem = GlobalAlloc(GMEM_MOVEABLE, n); }
		}
		pointer p = NULL;
		if (mem)
		{
			p = GlobalLock(mem);
		}
		return p;
	}
	pointer reallocate(pointer const p, size_t const n, bool const allow_movement)
	{
		pointer result = NULL;
		if (HGLOBAL h = GlobalHandle(p))
		{
			if (allow_movement || GlobalUnlock(h))
			{
				if (HGLOBAL const r = GlobalReAlloc(h, n, GMEM_MOVEABLE))
				{
					result = GlobalLock(r);
				}
			}
		}
		return result;
	}
};

namespace std { typedef basic_string<TCHAR> tstring; typedef basic_vector_based_string<TCHAR, std::char_traits<TCHAR>, dynamic_allocator<TCHAR> > tvstring; }
namespace std
{
	template<class> struct is_scalar;
#if defined(_CPPLIB_VER) && 600 <= _CPPLIB_VER
#ifdef _XMEMORY_
	template<class T1, class T2> struct is_scalar<std::pair<T1, T2> > : integral_constant<bool, is_pod<T1>::value && is_pod<T2>::value>{};
	template<class T1, class T2, class _Diff, class _Valty>
	inline void _Uninit_def_fill_n(std::pair<T1, T2> *_First, _Diff _Count, _Wrap_alloc<allocator<std::pair<T1, T2> > >&, _Valty *,
#if defined(_CPPLIB_VER) && _CPPLIB_VER >= 650
		_Trivially_copyable_ptr_iterator_tag
#else
		_Scalar_ptr_iterator_tag
#endif
	)
	{ _Fill_n(_First, _Count, _Valty()); }
#endif
#else
	template<class T> struct is_pod { static bool const value = __is_pod(T); };
#endif
	template<class It, class T, class Traits, class Ax>
	back_insert_iterator<basic_vector_based_string<T, Traits, Ax> > copy(It begin, It end, back_insert_iterator<basic_vector_based_string<T, Traits, Ax> > out)
	{
		typedef back_insert_iterator<basic_vector_based_string<T, Traits, Ax> > Base;
		struct Derived : Base { using Base::container; };
		typename Base::container_type &container = *static_cast<Derived &>(out).container;
		container.append(begin, end);
		return out;
	}
}

namespace stdext
{
	template<class T> struct remove_const          { typedef T type; };
	template<class T> struct remove_const<const T> { typedef T type; };

	template<class T> struct remove_volatile             { typedef T type; };
	template<class T> struct remove_volatile<volatile T> { typedef T type; };

	template<class T>
	struct remove_cv { typedef typename remove_volatile<typename remove_const<T>::type>::type type; };
}

struct File
{
	typedef int handle_type;
	handle_type f;
	~File() { if (f) { _close(f); } }
	operator handle_type &() { return this->f; }
	operator handle_type () const { return this->f; }
	handle_type *operator &() { return &this->f; }
};

#define X(Class) (GetProcAddress(GetModuleHandle(TEXT("win32u.dll")), HOOK_TYPE(Class)::static_name()))
HOOK_DEFINE_DEFAULT(HANDLE __stdcall, NtUserGetProp, (HWND hWnd, ATOM PropId), X);
HOOK_DEFINE_DEFAULT(BOOL __stdcall, NtUserSetProp, (HWND hWnd, ATOM PropId, HANDLE value), X);
HOOK_DEFINE_DEFAULT(LRESULT __stdcall, NtUserMessageCall, (HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam, ULONG_PTR xParam, DWORD xpfnProc, BOOL bAnsi), X);
HOOK_DEFINE_DEFAULT(BOOL __stdcall, NtUserRedrawWindow, (HWND hWnd, CONST RECT *lprcUpdate, HRGN hrgnUpdate, UINT flags), X);
#undef X

namespace atomic_namespace
{
#ifdef _ATOMIC_
	using namespace std;
#else
	extern "C" { void _ReadWriteBarrier(void); }
#pragma intrinsic(_ReadWriteBarrier)
	enum memory_order
	{
		memory_order_relaxed,
		memory_order_consume,
		memory_order_acquire,
		memory_order_release,
		memory_order_acq_rel,
		memory_order_seq_cst
	};
	struct atomic_flag
	{
		long _value;
		bool test_and_set(memory_order const order = memory_order_seq_cst) volatile { (void) order; return !!_interlockedbittestandset(&this->_value, 0); }
		void clear(memory_order const order = memory_order_seq_cst) volatile { (void) order; _interlockedbittestandreset(&this->_value, 0); }
	};
	template<class T>
	class atomic;
	template<>
	class atomic<bool>
	{
		typedef char storage_type;
		typedef bool value_type;
		storage_type value;
	public:
		atomic() { }
		explicit atomic(value_type const value) : value(value) { }
		operator value_type() const volatile { return this->load(); }
		atomic volatile &operator =(value_type const &value) volatile { this->store(value); return *this; }
		value_type exchange(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return !!_InterlockedExchange8(const_cast<storage_type *>(&this->value), static_cast<storage_type>(value)); }
		value_type load(memory_order const order = memory_order_seq_cst) const volatile { (void) order; return !!_InterlockedOr8(const_cast<storage_type *>(&this->value), storage_type()); }
		value_type store(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return !!_InterlockedExchange8(const_cast<storage_type *>(&this->value), static_cast<storage_type>(value)); }
	};
	template<>
	class atomic<unsigned int>
	{
		typedef long storage_type;
		typedef unsigned int value_type;
		storage_type value;
	public:
		atomic() { }
		explicit atomic(value_type const value) : value(value) { }
		operator value_type() const volatile { return this->load(); }
		atomic volatile &operator =(value_type const &value) volatile { this->store(value); return *this; }
		value_type exchange(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchange(&this->value, static_cast<storage_type>(value))); }
		value_type load(memory_order const order = memory_order_seq_cst) const volatile { (void) order; return static_cast<value_type>(_InterlockedOr(const_cast<storage_type volatile *>(&this->value), storage_type())); }
		value_type store(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchange(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_add(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchangeAdd(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_sub(value_type const value, memory_order const order = memory_order_seq_cst) volatile { return this->fetch_add(value_type() - value, order); }
	};

	template<>
	class atomic<long long>
	{
		typedef long long storage_type;
		typedef long long value_type;
		storage_type value;
#ifdef _M_IX86
		static storage_type _InterlockedOr64(storage_type volatile *const result, storage_type const value) { storage_type prev, curr; _ReadWriteBarrier(); do { prev = *result; curr = prev | value; } while (prev != _InterlockedCompareExchange64(result, curr, prev)); _ReadWriteBarrier(); return prev; }
		static storage_type _InterlockedExchange64(storage_type volatile *const result, storage_type const value) { storage_type prev; _ReadWriteBarrier(); do { prev = *result; } while (prev != _InterlockedCompareExchange64(result, value, prev)); _ReadWriteBarrier();  return (prev); }
		static storage_type _InterlockedExchangeAdd64(storage_type volatile *const result, storage_type const value) { storage_type prev, curr; _ReadWriteBarrier(); do { prev = *result; curr = prev + value; } while (prev != _InterlockedCompareExchange64(result, curr, prev)); _ReadWriteBarrier(); return prev; }
#endif
	public:
		atomic() { }
		explicit atomic(value_type const value) : value(value) { }
		operator value_type() const volatile { return this->load(); }
		atomic volatile &operator =(value_type const &value) volatile { this->store(value); return *this; }
		value_type exchange(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void)order; return static_cast<value_type>(_InterlockedExchange64(&this->value, static_cast<storage_type>(value))); }
		value_type load(memory_order const order = memory_order_seq_cst) const volatile { (void) order; return static_cast<value_type>(_InterlockedOr64(const_cast<storage_type volatile *>(&this->value), storage_type())); }
		value_type store(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchange64(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_add(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchangeAdd64(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_sub(value_type const value, memory_order const order = memory_order_seq_cst) volatile { return this->fetch_add(value_type() - value, order); }
	};

	template<>
	class atomic<unsigned long long>
	{
		typedef long long storage_type;
		typedef unsigned long long value_type;
		storage_type value;
#ifdef _M_IX86
		static storage_type _InterlockedOr64(storage_type volatile *const result, storage_type const value) { storage_type prev, curr; _ReadWriteBarrier(); do { prev = *result; curr = prev | value; } while (prev != _InterlockedCompareExchange64(result, curr, prev)); _ReadWriteBarrier(); return prev; }
		static storage_type _InterlockedExchange64(storage_type volatile *const result, storage_type const value) { storage_type prev; _ReadWriteBarrier(); do { prev = *result; } while (prev != _InterlockedCompareExchange64(result, value, prev)); _ReadWriteBarrier();  return (prev); }
		static storage_type _InterlockedExchangeAdd64(storage_type volatile *const result, storage_type const value) { storage_type prev, curr; _ReadWriteBarrier(); do { prev = *result; curr = prev + value; } while (prev != _InterlockedCompareExchange64(result, curr, prev)); _ReadWriteBarrier(); return prev; }
#endif
	public:
		atomic() { }
		explicit atomic(value_type const value) : value(value) { }
		operator value_type() const volatile { return this->load(); }
		atomic volatile &operator =(value_type const &value) volatile { this->store(value); return *this; }
		value_type exchange(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void)order; return static_cast<value_type>(_InterlockedExchange64(&this->value, static_cast<storage_type>(value))); }
		value_type load(memory_order const order = memory_order_seq_cst) const volatile { (void) order; return static_cast<value_type>(_InterlockedOr64(const_cast<storage_type volatile *>(&this->value), storage_type())); }
		value_type store(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchange64(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_add(value_type const value, memory_order const order = memory_order_seq_cst) volatile { (void) order; return static_cast<value_type>(_InterlockedExchangeAdd64(&this->value, static_cast<storage_type>(value))); }
		value_type fetch_sub(value_type const value, memory_order const order = memory_order_seq_cst) volatile { return this->fetch_add(value_type() - value, order); }
	};
#endif
#ifndef _MUTEX_
	template<class Mutex>
	class unique_lock
	{
		Mutex *p;
	public:
		typedef Mutex mutex_type;
		~unique_lock() { if (p) { p->unlock(); } }
		unique_lock() : p() { }
		explicit unique_lock(mutex_type *const mutex, bool const already_locked = false) : p(mutex) { if (p && !already_locked) { p->lock(); } }
		explicit unique_lock(mutex_type &mutex, bool const already_locked = false) : p(&mutex) { if (!already_locked) { p->lock(); } }
		unique_lock(unique_lock const &other) : p(other.p) { if (p) { p->lock(); } }
		unique_lock &operator =(unique_lock other) { return this->swap(other), *this; }
		void swap(unique_lock &other) { using std::swap; swap(this->p, other.p); }
		friend void swap(unique_lock &a, unique_lock &b) { return a.swap(b); }
		mutex_type *mutex() const { return this->p; }
	};
	class recursive_mutex
	{
		void init()
		{
#if defined(_WIN32)
			InitializeCriticalSection(&p);
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
			omp_init_lock(&p);
#endif
		}
		void term()
		{
#if defined(_WIN32)
			DeleteCriticalSection(&p);
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
			omp_destroy_lock(&p);
#endif
		}
	public:
		recursive_mutex &operator =(recursive_mutex const &) { return *this; }
#if defined(_WIN32)
		CRITICAL_SECTION p;
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
		omp_lock_t p;
#elif defined(BOOST_THREAD_MUTEX_HPP)
		boost::recursive_mutex m;
#else
		std::recursive_mutex m;
#endif
		recursive_mutex(recursive_mutex const &) { this->init(); }
		recursive_mutex() { this->init(); }
		~recursive_mutex() { this->term(); }
		void lock()
		{
#if defined(_WIN32)
			EnterCriticalSection(&p);
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
			omp_set_lock(&p);
#else
			return m.lock();
#endif
		}
		void unlock()
		{
#if defined(_WIN32)
			LeaveCriticalSection(&p);
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
			omp_unset_lock(&p);
#else
			return m.unlock();
#endif
		}
		bool try_lock()
		{
#if defined(_WIN32)
			return !!TryEnterCriticalSection(&p);
#elif defined(_OPENMP) || defined(_OMP_LOCK_T)
			return !!omp_test_lock(&p);
#else
			return m.try_lock();
#endif
		}
	};
#endif
}

template<size_t N>
int safe_stprintf(TCHAR (&s)[N], TCHAR const *const format, ...)
{
	int result;
	va_list args;
	va_start(args, format);
	result = _vsntprintf(s, N - 1, format, args);
	va_end(args);
	if (result < 0) { s[0] = _T('\0'); }
	else if (result == N - 1) { s[result] = _T('\0'); }
	return result;
}

atomic_namespace::recursive_mutex global_exception_mutex;


bool is_ascii(wchar_t const *const s, size_t const n)
{
	bool result = true;
	for (size_t i = 0; i != n; ++i)
	{
		wchar_t const ch = s[i];
		result &= (SCHAR_MIN <= static_cast<long long>(ch)) & (ch <= SCHAR_MAX);
	}
	return result;
}

static void append_directional(std::tvstring &str, TCHAR const sz[], size_t const cch, int const ascii_mode /* -1 = decompress ASCII, 0 = no change, +1 = compress ASCII */, bool const reverse = false)
{
	typedef std::tvstring Str;
	size_t const cch_in_str = ascii_mode > 0 ? (cch + 1) / 2 : cch;
	size_t const n = str.size();
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
	struct Derived : Str { using Str::_First; using Str::_Last; using Str::_End; using Str::allocator; };
	Derived &derived = static_cast<Derived &>(str);
#endif
	if (n + cch_in_str > str.capacity())
	{
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
		dynamic_allocator<TCHAR> &alloc /* ensure correct type of allocator! */ = derived.allocator;
		size_t const min_capacity = str.capacity() + str.capacity() / 2;
		size_t new_capacity = n + cch_in_str;
		if (new_capacity < min_capacity) { new_capacity = min_capacity; }
		if (TCHAR *const p = alloc.reallocate(derived._First, new_capacity, true /* TCHAR is movable */))
		{
			derived._First = p;
			derived._Last = derived._First + static_cast<ptrdiff_t>(n);
			derived._End = derived._First + static_cast<ptrdiff_t>(new_capacity);
		}
#endif
		str.reserve(n + n / 2 + cch_in_str * 2);
	}
#if defined(_MSC_VER) && !defined(_CPPLIB_VER)
	// we have enough capacity, so just extend
	derived._Last += static_cast<ptrdiff_t>(cch_in_str);
#else
	str.resize(n + cch_in_str);
#endif
	if (cch)
	{
		TCHAR *const o = &str[n];
		if (reverse)
		{
			if (ascii_mode < 0)
			{ std::reverse_copy(static_cast<char const *>(static_cast<void const *>(sz)), static_cast<char const *>(static_cast<void const *>(sz)) + static_cast<ptrdiff_t>(cch), o); }
			else if (ascii_mode > 0)
			{
				for (size_t i = 0; i != cch; ++i)
				{ static_cast<char *>(static_cast<void *>(o))[i] = static_cast<char>(sz[cch - 1 - i]); }
			}
			else
			{ std::reverse_copy(sz, sz + static_cast<ptrdiff_t>(cch), o); }
		}
		else
		{
			if (ascii_mode < 0)
			{ std::copy(static_cast<char const *>(static_cast<void const *>(sz)), static_cast<char const *>(static_cast<void const *>(sz)) + static_cast<ptrdiff_t>(cch), o); }
			else if (ascii_mode > 0)
			{
				for (size_t i = 0; i != cch; ++i)
				{ static_cast<char *>(static_cast<void *>(o))[i] = static_cast<char>(sz[i]); }
			}
			else
			{ std::copy(sz, sz + static_cast<ptrdiff_t>(cch), o); }
		}
	}
}

LPTSTR GetAnyErrorText(DWORD errorCode, va_list* pArgList = NULL)
{
	static TCHAR buffer[1 << 15];
	ZeroMemory(buffer, sizeof(buffer));
	if (!FormatMessage(FORMAT_MESSAGE_FROM_SYSTEM | (pArgList == NULL ? FORMAT_MESSAGE_IGNORE_INSERTS : 0), NULL, errorCode, 0, buffer, sizeof(buffer) / sizeof(*buffer), pArgList))
	{
		if (!FormatMessage(FORMAT_MESSAGE_FROM_HMODULE | (pArgList == NULL ? FORMAT_MESSAGE_IGNORE_INSERTS : 0), GetModuleHandle(_T("NTDLL.dll")), errorCode, 0, buffer, sizeof(buffer) / sizeof(*buffer), pArgList))
		{ safe_stprintf(buffer, _T("%#lx"), errorCode); }
	}
	return buffer;
}

struct Wow64
{
	static HMODULE GetKernel32()
	{
		HMODULE kernel32 = NULL;
		return GetModuleHandleEx(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCTSTR>(&GetSystemInfo), &kernel32) ? kernel32 : NULL;
	}
	typedef BOOL WINAPI IsWow64Process_t(IN HANDLE hProcess, OUT PBOOL Wow64Process); static IsWow64Process_t *IsWow64Process;
	static bool is_wow64()
	{
		bool result = false;
#ifdef _M_IX86
		BOOL isWOW64 = FALSE;
		if (!IsWow64Process)
		{ IsWow64Process = reinterpret_cast<IsWow64Process_t *>(GetProcAddress(GetKernel32(), _CRT_STRINGIZE(IsWow64Process))); }
		result = IsWow64Process && IsWow64Process(GetCurrentProcess(), &isWOW64) && isWOW64;
#endif
		return result;
	}
	typedef BOOL WINAPI Wow64DisableWow64FsRedirection_t(PVOID *OldValue); static Wow64DisableWow64FsRedirection_t *Wow64DisableWow64FsRedirection;
	static void *disable()
	{
		void *old = NULL;
#ifdef _M_IX86
		if (!Wow64DisableWow64FsRedirection)
		{ Wow64DisableWow64FsRedirection = reinterpret_cast<Wow64DisableWow64FsRedirection_t *>(GetProcAddress(GetKernel32(), _CRT_STRINGIZE(Wow64DisableWow64FsRedirection))); }
		if (Wow64DisableWow64FsRedirection && !Wow64DisableWow64FsRedirection(&old))
		{ old = NULL; }
#endif
		return old;
	}
	typedef BOOL WINAPI Wow64RevertWow64FsRedirection_t(PVOID OlValue); static Wow64RevertWow64FsRedirection_t *Wow64RevertWow64FsRedirection;
	static bool revert(PVOID old)
	{
		bool result = false;
#ifdef _M_IX86
		if (!Wow64RevertWow64FsRedirection)
		{ Wow64RevertWow64FsRedirection = reinterpret_cast<Wow64RevertWow64FsRedirection_t *>(GetProcAddress(GetKernel32(), _CRT_STRINGIZE(Wow64RevertWow64FsRedirection))); }
		result = Wow64RevertWow64FsRedirection && Wow64RevertWow64FsRedirection(old);
#endif
		return result;
	}
	Wow64() { }
};
#ifdef _M_IX86
Wow64 const init_wow64;
Wow64::IsWow64Process_t *Wow64::IsWow64Process = NULL;
Wow64::Wow64DisableWow64FsRedirection_t *Wow64::Wow64DisableWow64FsRedirection = NULL;
Wow64::Wow64RevertWow64FsRedirection_t *Wow64::Wow64RevertWow64FsRedirection = NULL;
#endif

struct Wow64Disable
{
	bool disable;
	void *cookie;
	Wow64Disable(bool disable) : disable(disable) { if (this->disable) { this->cookie = Wow64::disable(); } }
	~Wow64Disable() { if (this->disable) { Wow64::revert(this->cookie); } }
};


namespace winnt
{
	struct IO_STATUS_BLOCK { union { long Status; void *Pointer; }; uintptr_t Information; };

	enum IO_PRIORITY_HINT { IoPriorityVeryLow = 0, IoPriorityLow, IoPriorityNormal, IoPriorityHigh, IoPriorityCritical, MaxIoPriorityTypes };
	struct FILE_FS_SIZE_INFORMATION { long long TotalAllocationUnits, ActualAvailableAllocationUnits; unsigned long SectorsPerAllocationUnit, BytesPerSector; };
	struct FILE_FS_ATTRIBUTE_INFORMATION { unsigned long FileSystemAttributes; unsigned long MaximumComponentNameLength; unsigned long FileSystemNameLength; wchar_t FileSystemName[1]; };
	struct FILE_FS_DEVICE_INFORMATION { unsigned long DeviceType, Characteristics; } fsinfo;
	union FILE_IO_PRIORITY_HINT_INFORMATION { IO_PRIORITY_HINT PriorityHint; unsigned long long _alignment; };
	struct TIME_FIELDS { short Year; short Month; short Day; short Hour; short Minute; short Second; short Milliseconds; short Weekday; };

	template<class T> struct identity { typedef T type; };
	typedef long NTSTATUS;

#define X(F, T) identity<T>::type &F = *reinterpret_cast<identity<T>::type *const &>(static_cast<FARPROC const &>(GetProcAddress(GetModuleHandle(_T("ntdll.dll")), #F)))

	X(NtQueryVolumeInformationFile, NTSTATUS NTAPI(HANDLE FileHandle, IO_STATUS_BLOCK *IoStatusBlock, PVOID FsInformation, unsigned long Length, unsigned long FsInformationClass));
	X(NtQueryInformationFile, NTSTATUS NTAPI(IN HANDLE FileHandle, OUT IO_STATUS_BLOCK *IoStatusBlock, OUT PVOID FileInformation, IN ULONG Length, IN unsigned long FileInformationClass));
	X(NtSetInformationFile, NTSTATUS NTAPI(IN HANDLE FileHandle, OUT IO_STATUS_BLOCK *IoStatusBlock, IN PVOID FileInformation, IN ULONG Length, IN unsigned long FileInformationClass));
	X(RtlNtStatusToDosError, unsigned long NTAPI(IN NTSTATUS NtStatus));
	X(RtlTimeToTimeFields, VOID NTAPI(LARGE_INTEGER *Time, TIME_FIELDS *TimeFields));

#undef  X
}

bool isdevnull(int fd)
{
	winnt::IO_STATUS_BLOCK iosb;
	winnt::FILE_FS_DEVICE_INFORMATION fsinfo;
	return winnt::NtQueryVolumeInformationFile((HANDLE)_get_osfhandle(fd), &iosb, &fsinfo, sizeof(fsinfo), 4) == 0 && fsinfo.DeviceType == 0x00000015;
}

bool isdevnull(FILE *f)
{
	return isdevnull(
#ifdef _O_BINARY
		_fileno(f)
#else
		fileno(f)
#endif
	);
}

namespace ntfs
{
#pragma pack(push, 1)
	struct NTFS_BOOT_SECTOR
	{
		unsigned char Jump[3];
		unsigned char Oem[8];
		unsigned short BytesPerSector;
		unsigned char SectorsPerCluster;
		unsigned short ReservedSectors;
		unsigned char Padding1[3];
		unsigned short Unused1;
		unsigned char MediaDescriptor;
		unsigned short Padding2;
		unsigned short SectorsPerTrack;
		unsigned short NumberOfHeads;
		unsigned long HiddenSectors;
		unsigned long Unused2;
		unsigned long Unused3;
		long long TotalSectors;
		long long MftStartLcn;
		long long Mft2StartLcn;
		signed char ClustersPerFileRecordSegment;
		unsigned char Padding3[3];
		unsigned long ClustersPerIndexBlock;
		long long VolumeSerialNumber;
		unsigned long Checksum;

		unsigned char BootStrap[0x200 - 0x54];
		unsigned int file_record_size() const { return this->ClustersPerFileRecordSegment >= 0 ? this->ClustersPerFileRecordSegment * this->SectorsPerCluster * this->BytesPerSector : 1U << static_cast<int>(-this->ClustersPerFileRecordSegment); }
		unsigned int cluster_size() const { return this->SectorsPerCluster * this->BytesPerSector; }
	};
#pragma pack(pop)
	struct MULTI_SECTOR_HEADER
	{
		unsigned long Magic;
		unsigned short USAOffset;
		unsigned short USACount;
		
		bool unfixup(size_t max_size)
		{
			unsigned short *usa = reinterpret_cast<unsigned short *>(&reinterpret_cast<unsigned char *>(this)[this->USAOffset]);
			unsigned short const usa0 = usa[0];
			bool result = true;
			for (unsigned short i = 1; i < this->USACount; i++)
			{
				const size_t offset = i * 512 - sizeof(unsigned short);
				unsigned short *const check = (unsigned short *) ((unsigned char*)this + offset);
				if (offset < max_size)
				{
					result &= *check == usa0;
					*check = usa[i];
				}
				else { break; }
			}
			return result;
		}
	};
	enum AttributeTypeCode
	{
		AttributeStandardInformation = 0x10,
		AttributeAttributeList = 0x20,
		AttributeFileName = 0x30,
		AttributeObjectId = 0x40,
		AttributeSecurityDescriptor = 0x50,
		AttributeVolumeName = 0x60,
		AttributeVolumeInformation = 0x70,
		AttributeData = 0x80,
		AttributeIndexRoot = 0x90,
		AttributeIndexAllocation = 0xA0,
		AttributeBitmap = 0xB0,
		AttributeReparsePoint = 0xC0,
		AttributeEAInformation = 0xD0,
		AttributeEA = 0xE0,
		AttributePropertySet = 0xF0,
		AttributeLoggedUtilityStream = 0x100,
		AttributeEnd = -1,
	};
	struct ATTRIBUTE_RECORD_HEADER
	{
		AttributeTypeCode Type;
		unsigned long Length;
		unsigned char IsNonResident;
		unsigned char NameLength;
		unsigned short NameOffset;
		unsigned short Flags;  // 0x0001 = Compressed, 0x4000 = Encrypted, 0x8000 = Sparse
		unsigned short Instance;
		union
		{
			struct RESIDENT
			{
				unsigned long ValueLength;
				unsigned short ValueOffset;
				unsigned short Flags;
				inline void *GetValue() { return reinterpret_cast<void *>(reinterpret_cast<char *>(CONTAINING_RECORD(this, ATTRIBUTE_RECORD_HEADER, Resident)) + this->ValueOffset); }
				inline void const *GetValue() const { return reinterpret_cast<const void *>(reinterpret_cast<const char *>(CONTAINING_RECORD(this, ATTRIBUTE_RECORD_HEADER, Resident)) + this->ValueOffset); }
			} Resident;
			struct NONRESIDENT
			{
				long long LowestVCN;
				long long HighestVCN;
				unsigned short MappingPairsOffset;
				unsigned char CompressionUnit;
				unsigned char Reserved[5];
				long long AllocatedSize;
				long long DataSize;
				long long InitializedSize;
				long long CompressedSize;
			} NonResident;
		};
		ATTRIBUTE_RECORD_HEADER *next() { return reinterpret_cast<ATTRIBUTE_RECORD_HEADER *>(reinterpret_cast<unsigned char *>(this) + this->Length); }
		ATTRIBUTE_RECORD_HEADER const *next() const { return reinterpret_cast<ATTRIBUTE_RECORD_HEADER const *>(reinterpret_cast<unsigned char const *>(this) + this->Length); }
		wchar_t *name() { return reinterpret_cast<wchar_t *>(reinterpret_cast<unsigned char *>(this) + this->NameOffset); }
		wchar_t const *name() const { return reinterpret_cast<wchar_t const *>(reinterpret_cast<unsigned char const *>(this) + this->NameOffset); }
	};
	enum FILE_RECORD_HEADER_FLAGS
	{
		FRH_IN_USE = 0x0001,    /* Record is in use */
		FRH_DIRECTORY = 0x0002,    /* Record is a directory */
	};
	struct FILE_RECORD_SEGMENT_HEADER
	{
		MULTI_SECTOR_HEADER MultiSectorHeader;
		unsigned long long LogFileSequenceNumber;
		unsigned short SequenceNumber;
		unsigned short LinkCount;
		unsigned short FirstAttributeOffset;
		unsigned short Flags /* FILE_RECORD_HEADER_FLAGS */;
		unsigned long BytesInUse;
		unsigned long BytesAllocated;
		unsigned long long BaseFileRecordSegment;
		unsigned short NextAttributeNumber;
		//http://blogs.technet.com/b/joscon/archive/2011/01/06/how-hard-links-work.aspx
		unsigned short SegmentNumberUpper_or_USA_or_UnknownReserved;  // WARNING: This does NOT seem to be the actual "upper" segment number of anything! I found it to be 0x26e on one of my drives... and checkdisk didn't say anything about it
		unsigned long SegmentNumberLower;
		ATTRIBUTE_RECORD_HEADER *begin() { return reinterpret_cast<ATTRIBUTE_RECORD_HEADER *>(reinterpret_cast<unsigned char *>(this) + this->FirstAttributeOffset); }
		ATTRIBUTE_RECORD_HEADER const *begin() const { return reinterpret_cast<ATTRIBUTE_RECORD_HEADER const *>(reinterpret_cast<unsigned char const *>(this) + this->FirstAttributeOffset); }
		void *end(size_t const max_buffer_size = ~size_t()) { return reinterpret_cast<unsigned char *>(this) + (max_buffer_size < this->BytesInUse ? max_buffer_size : this->BytesInUse); }
		void const *end(size_t const max_buffer_size = ~size_t()) const { return reinterpret_cast<unsigned char const *>(this) + (max_buffer_size < this->BytesInUse ? max_buffer_size : this->BytesInUse); }
	};
	struct FILENAME_INFORMATION
	{
		unsigned long long ParentDirectory;
		long long CreationTime;
		long long LastModificationTime;
		long long LastChangeTime;
		long long LastAccessTime;
		long long AllocatedLength;
		long long FileSize;
		unsigned long FileAttributes;
		unsigned short PackedEaSize;
		unsigned short Reserved;
		unsigned char FileNameLength;
		unsigned char Flags;
		WCHAR FileName[1];
	};
	struct STANDARD_INFORMATION
	{
		long long CreationTime;
		long long LastModificationTime;
		long long LastChangeTime;
		long long LastAccessTime;
		unsigned long FileAttributes;
		// There's more, but only in newer versions
	};
	struct INDEX_HEADER
	{
		unsigned long FirstIndexEntry;
		unsigned long FirstFreeByte;
		unsigned long BytesAvailable;
		unsigned char Flags;  // '1' == has INDEX_ALLOCATION
		unsigned char Reserved[3];
	};
	struct INDEX_ROOT
	{
		AttributeTypeCode Type;
		unsigned long CollationRule;
		unsigned long BytesPerIndexBlock;
		unsigned char ClustersPerIndexBlock;
		INDEX_HEADER Header;
	};
	struct ATTRIBUTE_LIST
	{
		AttributeTypeCode AttributeType;
		unsigned short Length;
		unsigned char NameLength;
		unsigned char NameOffset;
		unsigned long long StartVcn; // LowVcn
		unsigned long long FileReferenceNumber;
		unsigned short AttributeNumber;
		unsigned short AlignmentOrReserved[3];
	};
	enum ReparseTypeFlags
	{
		ReparseIsMicrosoft = 0x80000000,
		ReparseIsHighLatency = 0x40000000,
		ReparseIsAlias = 0x20000000,
		ReparseTagNSS = 0x68000005,
		ReparseTagNSSRecover = 0x68000006,
		ReparseTagSIS = 0x68000007,
		ReparseTagSDFS = 0x68000008,
		ReparseTagMountPoint = 0x88000003,
		ReparseTagHSM = 0xA8000004,
		ReparseTagSymbolicLink = 0xE8000000,
		ReparseTagMountPoint2 = 0xA0000003,
		ReparseTagSymbolicLink2 = 0xA000000C,
		ReparseTagWofCompressed = 0x80000017,
		ReparseTagWindowsContainerImage = 0x80000018,
		ReparseTagGlobalReparse = 0x80000019,
		ReparseTagAppExecLink = 0x8000001B,
		ReparseTagCloud = 0x9000001A,
		ReparseTagGVFS = 0x9000001C,
		ReparseTagLinuxSymbolicLink = 0xA000001D,
		// Lots more exist... see https://github.com/JFLarvoire/SysToolsLib/blob/master/C/MsvcLibX/include/reparsept.h
	};
	struct REPARSE_POINT
	{
		ReparseTypeFlags TypeFlags;
		unsigned short DataLength;
		unsigned short Padding;
		// Reparse GUID follows if third-party
		// Reparse data follows in all cases
		void *begin() { return reinterpret_cast<void *>(reinterpret_cast<unsigned char *>(this) + sizeof(*this)); }
		void const *begin() const { return reinterpret_cast<void const *>(reinterpret_cast<unsigned char const *>(this) + sizeof(*this)); }
		void *end(size_t const max_buffer_size = ~size_t()) { return reinterpret_cast<unsigned char *>(this->begin()) + static_cast<ptrdiff_t>(this->DataLength); }
		void const *end(size_t const max_buffer_size = ~size_t()) const { return reinterpret_cast<unsigned char const *>(this->begin()) + static_cast<ptrdiff_t>(this->DataLength); }
	};
	struct REPARSE_MOUNT_POINT_BUFFER
	{
		USHORT  SubstituteNameOffset;
		USHORT  SubstituteNameLength;
		USHORT  PrintNameOffset;
		USHORT  PrintNameLength;
		WCHAR  PathBuffer[1];
	};
	static struct { TCHAR const *data; size_t size; } attribute_names [] =
	{
#define X(S) { _T(S), sizeof(_T(S)) / sizeof(*_T(S)) - 1 }
		X(""),
		X("$STANDARD_INFORMATION"),
		X("$ATTRIBUTE_LIST"),
		X("$FILE_NAME"),
		X("$OBJECT_ID"),
		X("$SECURITY_DESCRIPTOR"),
		X("$VOLUME_NAME"),
		X("$VOLUME_INFORMATION"),
		X("$DATA"),
		X("$INDEX_ROOT"),
		X("$INDEX_ALLOCATION"),
		X("$BITMAP"),
		X("$REPARSE_POINT"),
		X("$EA_INFORMATION"),
		X("$EA"),
		X("$PROPERTY_SET"),
		X("$LOGGED_UTILITY_STREAM"),
#undef  X
	};
}

void remove_path_stream_and_trailing_sep(std::tvstring &path)
{
	size_t ifirstsep = 0;
	while (ifirstsep < path.size())
	{
		if (isdirsep(path[ifirstsep]))
		{
			break;
		}
		++ifirstsep;
	}
	while (!path.empty() && isdirsep(*(path.end() - 1)))
	{
		if (path.size() <= ifirstsep + 1)
		{
			break;
		}
		path.erase(path.end() - 1);
	}
	for (size_t i = path.size(); i != 0 && ((void)--i, true); )
	{
		if (path[i] == _T(':'))
		{
			path.erase(path.begin() + static_cast<ptrdiff_t>(i), path.end());
		}
		else if (isdirsep(path[i]))
		{
			break;
		}
	}
	while (!path.empty() && isdirsep(*(path.end() - 1)))
	{
		if (path.size() <= ifirstsep + 1)
		{
			break;
		}
		path.erase(path.end() - 1);
	}
	if (!path.empty() && *(path.end() - 1) == _T('.') && (path.size() == 1 || isdirsep(*(path.end() - 2))))
	{
		path.erase(path.end() - 1);
	}
}

std::tvstring NormalizePath(std::tvstring const &path)
{
	std::tvstring result;
	bool wasSep = false;
	bool isCurrentlyOnPrefix = true;
	for (size_t i = 0; i < path.size(); i++)
	{
		TCHAR const &c = path[i];
		isCurrentlyOnPrefix &= isdirsep(c);
		if (isCurrentlyOnPrefix || !wasSep || !isdirsep(c)) { result.push_back(c); }
		wasSep = isdirsep(c);
	}
	if (!isrooted(result.begin(), result.end()))
	{
		std::tvstring currentDir(32 * 1024, _T('\0'));
		currentDir.resize(GetCurrentDirectory(static_cast<DWORD>(currentDir.size()), &currentDir[0]));
		adddirsep(currentDir);
		result = currentDir + result;
	}
	remove_path_stream_and_trailing_sep(result);
	return result;
}


class Handle
{
	static bool valid(void *const value) { return value && value != reinterpret_cast<void *>(-1); }
public:
	void *value;
	Handle() : value() { }
	explicit Handle(void *const value) : value(value)
	{
		if (!valid(value))
		{ throw std::invalid_argument("invalid handle"); }
	}
	Handle(Handle const &other) : value(other.value)
	{
		if (valid(this->value))
		{ CheckAndThrow(DuplicateHandle(GetCurrentProcess(), this->value, GetCurrentProcess(), &this->value, MAXIMUM_ALLOWED, TRUE, DUPLICATE_SAME_ACCESS)); }
	}
	~Handle() { if (valid(this->value)) { CloseHandle(value); } }
	Handle &operator =(Handle other) { return other.swap(*this), *this; }
	operator void *() const volatile { return this->value; }
	operator void *() const { return this->value; }
	void swap(Handle &other) { using std::swap; swap(this->value, other.value); }
	friend void swap(Handle &a, Handle &b) { return a.swap(b); }
};

class IoPriority
{
	uintptr_t _volume;
	winnt::IO_PRIORITY_HINT _old;
	IoPriority &operator =(IoPriority const &);
public:
	static winnt::IO_PRIORITY_HINT query(uintptr_t const file)
	{
		winnt::FILE_IO_PRIORITY_HINT_INFORMATION old = { winnt::IoPriorityNormal };
		winnt::IO_STATUS_BLOCK iosb;
		winnt::NtQueryInformationFile(reinterpret_cast<HANDLE>(file), &iosb, &old, sizeof(old), 43);
		return old.PriorityHint;
	}
	static void set(uintptr_t const volume, winnt::IO_PRIORITY_HINT const value)
	{
		if (value != winnt::MaxIoPriorityTypes)
		{
			winnt::IO_STATUS_BLOCK iosb;
			winnt::FILE_IO_PRIORITY_HINT_INFORMATION io_priority = { value };
			winnt::NTSTATUS const status = winnt::NtSetInformationFile(reinterpret_cast<HANDLE>(volume), &iosb, &io_priority, sizeof(io_priority), 43);
			if (status != 0 && status != 0xC0000003 /*STATUS_INVALID_INFO_CLASS*/ && status != 0xC0000008 /* STATUS_INVALID_HANDLE */ && status != 0xC0000024 /* STATUS_OBJECT_TYPE_MISMATCH */)
			{
#ifdef _DEBUG
				CppRaiseException(winnt::RtlNtStatusToDosError(status));
#endif
			}
		}
	}
	uintptr_t volume() const { return this->_volume; }
	IoPriority() : _volume(), _old() { }
	IoPriority(IoPriority const &other) : _volume(other._volume), _old() { this->_old = winnt::MaxIoPriorityTypes; }
	explicit IoPriority(uintptr_t const volume, winnt::IO_PRIORITY_HINT const priority) : _volume(volume), _old(query(volume)) { set(volume, priority); }
	winnt::IO_PRIORITY_HINT old() const { return this->_old; }
	~IoPriority() { if (this->_volume) { set(this->_volume, this->_old); } }
	void swap(IoPriority &other) { using std::swap; swap(this->_volume, other._volume); swap(this->_old, other._old); }
};

template<class T, class Alloc =
#if defined(MEMORY_HEAP_HPP)
	memheap::MemoryHeapAllocator
#else
	std::allocator
#endif
	<T>
>
class memheap_vector : std::vector<T, Alloc>
{
	typedef std::vector<T, Alloc> base_type;
	typedef memheap_vector this_type;
protected:
	typename base_type::size_type _reserve(typename base_type::size_type extra_capacity)
	{
		typename base_type::size_type extra_reserved = 0;
#if defined(MEMORY_HEAP_HPP) && defined(_CPPLIB_VER) && 600 <= _CPPLIB_VER && _CPPLIB_VER <= 699
		typename base_type::size_type const current_capacity = this->base_type::capacity();
		if (current_capacity > 0 && extra_capacity > current_capacity - this->base_type::size())
		{
			extra_capacity = this->base_type::_Grow_to(current_capacity + extra_capacity) - current_capacity;
			if (typename base_type::pointer const ptr = this->base_type::get_allocator().allocate(extra_capacity, this->base_type::_Myend(), true))
			{
				if (ptr == this->base_type::_Myend())
				{
					this->base_type::_Myend() = ptr + static_cast<typename base_type::difference_type>(extra_capacity);
					extra_reserved = extra_capacity;
				}
				else
				{
					this->base_type::get_allocator().deallocate(ptr, extra_capacity);
				}
			}
		}
#else
		(void) extra_capacity;
#endif
		return extra_reserved;
	}
public:
	typedef typename base_type::allocator_type allocator_type;
	typedef typename base_type::value_type value_type;
	// typedef typename base_type::pointer pointer;
	// typedef typename base_type::const_pointer const_pointer;
	typedef typename base_type::reference reference;
	typedef typename base_type::const_reference const_reference;
	typedef typename base_type::iterator iterator;
	typedef typename base_type::const_iterator const_iterator;
	typedef typename base_type::reverse_iterator reverse_iterator;
	typedef typename base_type::const_reverse_iterator const_reverse_iterator;
	typedef typename base_type::size_type size_type;
	typedef typename base_type::difference_type difference_type;
	memheap_vector() : base_type() { }
	memheap_vector(base_type const &other) : base_type(other) { }
	explicit memheap_vector(allocator_type const &alloc) : base_type(alloc) { }
	using base_type::begin;
	using base_type::end;
	using base_type::rbegin;
	using base_type::rend;
	using base_type::size;
	using base_type::empty;
	using base_type::capacity;
	using base_type::clear;
	void swap(this_type &other) { this->base_type::swap(static_cast<this_type &>(other)); }
	friend void swap(this_type &me, this_type &other) { return me.swap(other); }
	void reserve(size_type const size)
	{
		typename base_type::size_type const current_size = this->base_type::size(), size_difference = size > current_size ? size - current_size : 0;
		if (size_difference && this->_reserve(size_difference) < size_difference)
		{
			this->base_type::reserve(size);
		}
	}
	void push_back(value_type const &value) { this->_reserve(1); return this->base_type::push_back(value); }
	void resize(size_type const size, value_type const &fill)
	{
		typename base_type::size_type const current_size = this->base_type::size();
		if (size > current_size) { this->_reserve(size - current_size); }
		return this->base_type::resize(size, fill);
	}
	void resize(size_type const size)
	{
		typename base_type::size_type const current_size = this->base_type::size();
		if (size > current_size) { this->_reserve(size - current_size); }
		return this->base_type::resize(size);
	}
};

unsigned int get_cluster_size(void *const volume)
{
	winnt::IO_STATUS_BLOCK iosb;
	winnt::FILE_FS_SIZE_INFORMATION info = {};
	if (unsigned long const error = winnt::RtlNtStatusToDosError(winnt::NtQueryVolumeInformationFile(volume, &iosb, &info, sizeof(info), 3)))
	{ CppRaiseException(error); }
	return info.BytesPerSector * info.SectorsPerAllocationUnit;
}

std::vector<std::pair<unsigned long long, long long> > get_retrieval_pointers(TCHAR const path[], long long *const size, long long const mft_start_lcn, unsigned int const file_record_size)
{
	(void) mft_start_lcn;
	(void) file_record_size;
	typedef std::vector<std::pair<unsigned long long, long long> > Result;
	Result result;
	Handle handle;
	if (path)
	{
		HANDLE const opened = CreateFile(path, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_NO_BUFFERING, NULL);
		unsigned long const error = opened != INVALID_HANDLE_VALUE ? ERROR_SUCCESS : GetLastError();
		if (!error) { Handle(opened).swap(handle); }
		else if (error == ERROR_FILE_NOT_FOUND) { /* do nothing */ }
		else if (error) { CppRaiseException(error); }
	}
	if (handle)
	{
		result.resize(1 + (sizeof(RETRIEVAL_POINTERS_BUFFER) - 1) / sizeof(Result::value_type));
		STARTING_VCN_INPUT_BUFFER input = {};
		BOOL success;
		for (unsigned long nr; !(success = DeviceIoControl(handle, FSCTL_GET_RETRIEVAL_POINTERS, &input, sizeof(input), &*result.begin(), static_cast<unsigned long>(result.size()) * sizeof(*result.begin()), &nr, NULL), success) && GetLastError() == ERROR_MORE_DATA;)
		{
			size_t const n = result.size();
			Result(/* free old memory */).swap(result);
			Result(n * 2).swap(result);
		}
		CheckAndThrow(success);
		if (size)
		{
			LARGE_INTEGER large_size;
			CheckAndThrow(GetFileSizeEx(handle, &large_size));
			*size = large_size.QuadPart;
		}
		result.erase(result.begin() + 1 + reinterpret_cast<unsigned long const &>(*result.begin()), result.end());
		result.erase(result.begin(), result.begin() + 1);
	}
	return result;
}

template<class From, class To> struct propagate_const { typedef To type; };
template<class From, class To> struct propagate_const<From const, To> : propagate_const<From, To const> { };
template<class From, class To> struct propagate_const<From &, To> : propagate_const<From, To> { };

namespace atomic_namespace
{
	class spin_lock : private atomic_flag
	{
	public:
		spin_lock() : atomic_flag() { }
		void lock() { while (this->test_and_set()) {} }
		void unlock() { this->clear(); }
	};

	template<class T>
	class spin_atomic
	{
		typedef spin_lock mutex;
		typedef unique_lock<mutex> unique_lock_t;
		mutex _mutex;
		typedef T storage_type;
		typedef T value_type;
		storage_type value;
	public:
		spin_atomic() { }
		explicit spin_atomic(value_type const &value) : value(value) { }
		value_type exchange(value_type value, memory_order const order = memory_order_seq_cst) volatile { (void) order; unique_lock_t const lock(const_cast<mutex &>(this->_mutex)); using std::swap; swap(const_cast<storage_type &>(this->value), value); return value; }
		value_type load(memory_order const order = memory_order_seq_cst) const volatile { (void) order; unique_lock_t const lock(const_cast<mutex &>(this->_mutex)); return const_cast<storage_type &>(this->value); }
		void store(value_type const &value, memory_order const order = memory_order_seq_cst) volatile { (void) order; unique_lock_t const lock(const_cast<mutex &>(this->_mutex)); const_cast<storage_type &>(this->value) = value; }
		value_type fetch_add(value_type const &value, memory_order const order = memory_order_seq_cst) volatile { (void) order; unique_lock_t const lock(const_cast<mutex &>(this->_mutex)); value_type old = const_cast<storage_type &>(this->value); const_cast<storage_type &>(this->value) += value; return old; }
		value_type fetch_sub(value_type const &value, memory_order const order = memory_order_seq_cst) volatile { (void) order; unique_lock_t const lock(const_cast<mutex &>(this->_mutex)); value_type old = const_cast<storage_type &>(this->value); const_cast<storage_type &>(this->value) -= value; return old; }
	};
}

template<class T>
struct intrusive_ptr
{
	typedef T value_type, element_type;
	typedef intrusive_ptr this_type;
	typedef value_type const *const_pointer;
	typedef value_type *pointer;
	pointer p;
	~intrusive_ptr() { if (this->p) { intrusive_ptr_release(this->p); } }
	void ref() { if (this->p) { intrusive_ptr_add_ref(this->p); } }
	pointer detach() { pointer p_ = this->p; this->p = NULL; return p_; }
	intrusive_ptr(pointer const p = NULL, bool const addref = true) : p(p) { if (addref) { this->ref(); } }
	template<class U> intrusive_ptr(intrusive_ptr<U> const &p, bool const addref = true) : p(p.get()) { if (addref) { this->ref(); } }
	intrusive_ptr(this_type const &other) : p(other.p) { this->ref(); }
	this_type &operator =(this_type other) { return other.swap(*this), *this; }
	pointer operator->() const { return this->p; }
	pointer get() const { return this->p; }
	void reset(pointer const p = NULL, bool const add_ref = true) { this_type(p, add_ref).swap(*this); }
	operator pointer() { return this->p; }
	operator const_pointer() const { return this->p; }
	void swap(this_type &other) { using std::swap; swap(this->p, other.p); }
	friend void swap(this_type &a, this_type &b) { return a.swap(b); }
	bool operator==(const_pointer const p) const { return this->p == p; } friend bool operator==(const_pointer const p, this_type const &me) { return p == me.get(); }
	bool operator!=(const_pointer const p) const { return this->p != p; } friend bool operator!=(const_pointer const p, this_type const &me) { return p != me.get(); }
	bool operator<=(const_pointer const p) const { return this->p <= p; } friend bool operator<=(const_pointer const p, this_type const &me) { return p <= me.get(); }
	bool operator>=(const_pointer const p) const { return this->p >= p; } friend bool operator>=(const_pointer const p, this_type const &me) { return p >= me.get(); }
	bool operator< (const_pointer const p) const { return this->p <  p; } friend bool operator< (const_pointer const p, this_type const &me) { return p <  me.get(); }
	bool operator> (const_pointer const p) const { return this->p >  p; } friend bool operator> (const_pointer const p, this_type const &me) { return p >  me.get(); }
};

template<class Derived>
class RefCounted
{
	mutable atomic_namespace::atomic<unsigned int> refs;
	friend void intrusive_ptr_add_ref(RefCounted const volatile *p) { p->refs.fetch_add(1, atomic_namespace::memory_order_acq_rel); }
	friend void intrusive_ptr_release(RefCounted const volatile *p)
	{
		if (p->refs.fetch_sub(1, atomic_namespace::memory_order_acq_rel) - 1 == 0)
		{
			delete static_cast<Derived const volatile *>(p);
		}
	}

protected:
	RefCounted() : refs(0) { }
	RefCounted(RefCounted const &) : refs(0) { }
	~RefCounted() { }
	RefCounted &operator =(RefCounted const &) { }
	void swap(RefCounted &) { }
};

class Overlapped : public OVERLAPPED, public RefCounted<Overlapped>
{
	Overlapped(Overlapped const &);
	Overlapped &operator =(Overlapped const &);
public:
	virtual ~Overlapped() { }
	Overlapped() : OVERLAPPED() { }
	virtual int /* > 0 if re-queue requested, = 0 if no re-queue but no destruction, < 0 if destruction requested */ operator()(size_t const size, uintptr_t const /*key*/) = 0;
	long long offset() const
	{
		return (static_cast<long long>(this->OVERLAPPED::OffsetHigh) << (CHAR_BIT * sizeof(this->OVERLAPPED::Offset))) | this->OVERLAPPED::Offset;
	}
	void offset(long long const value)
	{
		this->OVERLAPPED::Offset = static_cast<unsigned long>(value);
		this->OVERLAPPED::OffsetHigh = static_cast<unsigned long>(value >> (CHAR_BIT * sizeof(this->OVERLAPPED::Offset)));
	}
};

static struct negative_one
{
	template<class T>
	operator T() const { return static_cast<T>(~T()); }
} const negative_one;

template<class T>
struct value_initialized
{
	typedef value_initialized this_type, type;
	T value;
	value_initialized() : value() { }
	value_initialized(T const &value) : value(value) { }
	operator T &() { return this->value; }
	operator T const &() const { return this->value; }
	operator T volatile &() volatile { return this->value; }
	operator T const volatile &() const volatile { return this->value; }
	T *operator &() { return &this->value; }
	T const *operator &() const { return &this->value; }
	T volatile *operator &() volatile { return &this->value; }
	T const volatile *operator &() const volatile { return &this->value; }
};

template<size_t V>
class constant
{
	template<size_t I, size_t N>
	struct impl;
public:
	friend size_t operator *(size_t const m, constant<V> const)
	{
		return impl<0, sizeof(V) * CHAR_BIT>::multiply(m);
	}
};
template<size_t V> template<size_t I, size_t N> struct constant<V>::impl
{
	static size_t multiply(size_t const m) { return impl<I, N / 2>::multiply(m) + impl<I + N / 2, N - N / 2>::multiply(m); }
};
template<size_t V> template<size_t I> struct constant<V>::impl<I, 1>
{
	static size_t multiply(size_t const m) { return (V & static_cast<size_t>(static_cast<size_t>(1) << I)) ? static_cast<size_t>(m << I) : size_t(); }
};
template<> class constant<0xD> { public: friend size_t operator *(size_t const m, constant<0xD> const) { return (m << 4) - (m << 1) - m; } };

template<class It>
typename propagate_const<typename std::iterator_traits<It>::reference, typename std::iterator_traits<It>::value_type>::type *fast_subscript(It const it, size_t const i)
{
	return
#if 1
		&*(it + static_cast<ptrdiff_t>(i))
#else
		reinterpret_cast<typename propagate_const<typename std::iterator_traits<It>::reference, typename std::iterator_traits<It>::value_type>::type *>(
			reinterpret_cast<typename propagate_const<typename std::iterator_traits<It>::reference, unsigned char>::type *>(&*it) + i * constant<sizeof(*it)>())
#endif
		;
}

class buffer
{
	typedef buffer this_type;
	typedef void value_type_internal;
	typedef value_type_internal *pointer_internal;
	typedef size_t size_type_internal;
	typedef ptrdiff_t difference_type;
	pointer_internal p;
	size_type_internal c, n;
	void init() { if (!this->p && this->c) { using namespace std; this->p = malloc(this->c); } }
public:
	typedef value_type_internal value_type;
	typedef size_type_internal size_type;
	typedef pointer_internal pointer;
	typedef value_type const *const_pointer;
	typedef unsigned char &reference;
	typedef unsigned char const &const_reference;
	typedef unsigned char *iterator;
	typedef unsigned char const *const_iterator;
	~buffer() { using namespace std; free(this->p); }
	buffer() : p(), c(), n() { }
	explicit buffer(size_type const c) : p(), c(c), n() { this->init(); }
	buffer(this_type const &other) : p(), c(other.c), n() { this->init(); this->n = static_cast<size_type>(std::uninitialized_copy(other.begin(), other.end(), this->begin()) - this->begin()); }
	pointer get() const { return this->p; }
	size_type size() const { return this->n; }
	size_type capacity() const { return this->c; }
	this_type &operator =(this_type other) { return other.swap(*this), *this; }
	pointer tail() { return static_cast<unsigned char *>(this->p) + static_cast<ptrdiff_t>(this->n); }
	const_pointer tail() const { return static_cast<unsigned char const *>(this->p) + static_cast<ptrdiff_t>(this->n); }
	void swap(this_type &other) { using std::swap; swap(this->p, other.p); swap(this->c, other.c); swap(this->n, other.n); }
	friend void swap(this_type &a, this_type &b) { return a.swap(b); }
	iterator begin() { return static_cast<iterator>(this->get()); }
	const_iterator begin() const { return static_cast<const_iterator>(this->get()); }
	iterator end() { return static_cast<iterator>(this->tail()); }
	const_iterator end() const { return static_cast<const_iterator>(this->tail()); }
	bool empty() const { return !this->n; }
	void clear() { buffer().swap(*this); }
	template<class T>
	T *emplace_back(size_type const size = sizeof(T))
	{
		size_type const old_size = this->size();
		this->resize(old_size + size);
		return new (static_cast<unsigned char *>(this->get()) + static_cast<difference_type>(old_size)) T;
	}
	reference operator[](size_type const i) { return *(this->begin() + static_cast<difference_type>(i)); }
	const_reference operator[](size_type const i) const { return *(this->begin() + static_cast<difference_type>(i)); }
	// These arguments are in BYTES and not elements, so users might get confused
	void reserve_bytes(size_type c)
	{
		if (c > this->c)
		{
			size_type const min_c = this->c + this->c / 2;
			if (c < min_c) { c = min_c; }
			using namespace std;
			this->p = realloc(this->p, this->n);  // shrink first, to avoid copying memory beyond the block
			this->c = this->n;
			this->p = realloc(this->p, c);
			this->c = c;
		}
	}
private:
	void resize(size_type const n)
	{
		if (n <= this->c)
		{
			// No destructors to call here...
			this->n = n;
		}
		else
		{
			size_type c = this->c + this->c / 2;
			if (c < n) { c = n; }
			using namespace std;
			this->p = c ? realloc(this->p, c) : NULL;
			this->n = n;
		}
	}
};

template<class T, class Ax = std::allocator<T> >
class vector_with_fast_size : std::vector<T, Ax>
{
	typedef std::vector<T, Ax> base_type;
	typename base_type::size_type _size;
public:
	vector_with_fast_size() : _size() { }
	typedef typename base_type::const_iterator const_iterator;
	typedef typename base_type::iterator iterator;
	typedef typename base_type::size_type size_type;
	typedef typename base_type::value_type value_type;
	using base_type::at;
	using base_type::back;
	using base_type::begin;
	using base_type::capacity;
	using base_type::empty;
	using base_type::end;
	using base_type::front;
	using base_type::reserve;
	using base_type::operator[];
	size_type size() const
	{
		return this->_size;
	}
	void resize(size_type const size)
	{
		this->base_type::resize(size);
		this->_size = size;
	}
	void resize(size_type const size, value_type const &default_value)
	{
		this->base_type::resize(size, default_value);
		this->_size = size;
	}
	void push_back(value_type const &value)
	{
		this->base_type::push_back(value);
		++this->_size;
	}
};

struct Speed : std::pair<unsigned long long, clock_t>
{
	Speed() { }
	Speed(first_type const &first, second_type const &second) : std::pair<first_type, second_type>(first, second) { }
	Speed &operator+=(Speed const &other) { this->first += other.first; this->second += other.second; return *this; }
};

template<class T> struct remove_volatile             { typedef T type; };
template<class T> struct remove_volatile<T volatile> { typedef T type; };

template<class T>
struct mutable_
{
	mutable T value;
};

template<class T>
class lock_ptr : atomic_namespace::unique_lock<atomic_namespace::recursive_mutex>
{
	typedef atomic_namespace::unique_lock<atomic_namespace::recursive_mutex> base_type;
	typedef lock_ptr this_type;
	T *me;
	lock_ptr(this_type const &);
	this_type &operator =(this_type const &);
public:
	~lock_ptr() { }
	lock_ptr(T volatile *const me, bool const do_lock = true) : base_type(), me(const_cast<T *>(me))
	{
		if (do_lock && me)
		{
			base_type temp(me->get_mutex());
			using std::swap; swap(temp, static_cast<base_type &>(*this));
		}
	}
	lock_ptr(T *const me, bool const do_lock = true) : base_type(), me(me)
	{
		if (do_lock && me)
		{
			base_type temp(me->get_mutex());
			using std::swap; swap(temp, static_cast<base_type &>(*this));
		}
	}
	lock_ptr() : base_type(), me() { }
	T *operator->() const { return me; }
	T &operator *() const { return *me; }
	void swap(this_type &other)
	{
		using std::swap;
		swap(static_cast<base_type &>(*this), static_cast<base_type &>(other));
		swap(this->me, other.me);
	}
	this_type &init(T volatile *const me) { this_type(me).swap(*this); return *this; }
	this_type &init(T *const me) { this_type(me).swap(*this); return *this; }
};

template<class T>
lock_ptr<typename remove_volatile<T>::type> &lock(T *const value, mutable_<lock_ptr<typename remove_volatile<T>::type> > const &holder = mutable_<lock_ptr<typename remove_volatile<T>::type> >())
{
	return holder.value.init(value);
}

template<class T>
lock_ptr<typename remove_volatile<T>::type> &lock(intrusive_ptr<T> const &value, mutable_<lock_ptr<typename remove_volatile<T>::type> > const &holder = mutable_<lock_ptr<typename remove_volatile<T>::type> >())
{
	return lock<T>(value.get(), holder);
}

class NtfsIndex : public RefCounted<NtfsIndex>
{
	typedef NtfsIndex this_type;
	template<class = void> struct small_t { typedef unsigned int type; };
#pragma pack(push, 1)
	class file_size_type
	{
		unsigned int low;
		unsigned short high;
		typedef file_size_type this_type;
	public:
		file_size_type() : low(), high() { }
		file_size_type(unsigned long long const value) : low(static_cast<unsigned int>(value)), high(static_cast<unsigned short>(value >> (sizeof(unsigned int) * CHAR_BIT))) { }
		operator unsigned long long() const { return (static_cast<unsigned long long>(this->high) << (sizeof(unsigned int) * CHAR_BIT)) | this->low; }
		this_type &operator+=(unsigned long long const &other) { return *this = *this + other; }
		this_type &operator-=(unsigned long long const &other) { return *this = *this - other; }
	};
	struct StandardInfo
	{
		unsigned long long
			created,
			written,
			accessed : 0x40 - 6,
			is_system : 1,
			is_directory : 1,
			is_sparse : 1,
			is_compressed : 1,
			is_encrypted : 1,
			is_reparse : 1;

		unsigned long attributes() const
		{
			return (this->is_system ? FILE_ATTRIBUTE_SYSTEM : 0U) |
				(this->is_directory ? FILE_ATTRIBUTE_DIRECTORY : 0U) |
				(this->is_sparse ? FILE_ATTRIBUTE_SPARSE_FILE : 0U) |
				(this->is_compressed ? FILE_ATTRIBUTE_COMPRESSED : 0U) |
				(this->is_encrypted ? FILE_ATTRIBUTE_ENCRYPTED : 0U) |
				(this->is_reparse ? FILE_ATTRIBUTE_REPARSE_POINT : 0U);
		}

		void attributes(unsigned long const value)
		{
			this->is_system = !!(value & FILE_ATTRIBUTE_SYSTEM);
			this->is_directory = !!(value & FILE_ATTRIBUTE_DIRECTORY);
			this->is_sparse = !!(value & FILE_ATTRIBUTE_SPARSE_FILE);
			this->is_compressed = !!(value & FILE_ATTRIBUTE_COMPRESSED);
			this->is_encrypted = !!(value & FILE_ATTRIBUTE_ENCRYPTED);
			this->is_reparse = !!(value & FILE_ATTRIBUTE_REPARSE_POINT);
		}
	};
	struct SizeInfo
	{
		file_size_type length, allocated, bulkiness;
		value_initialized<unsigned int>::type treesize;
	};
	friend struct std::is_scalar<StandardInfo>;
	struct NameInfo
	{
		small_t<size_t>::type _offset;
		bool ascii() const { return !!(this->_offset & 1U); }
		void ascii(bool const value) { this->_offset = static_cast<small_t<size_t>::type>((this->_offset & static_cast<small_t<size_t>::type>(~static_cast<small_t<size_t>::type>(1U))) | (value ? 1U : small_t<size_t>::type())); }
		small_t<size_t>::type offset() const { small_t<size_t>::type result = this->_offset >> 1; if (result == (static_cast<small_t<size_t>::type>(negative_one) >> 1)) { result = static_cast<small_t<size_t>::type>(negative_one); } return result; }
		void offset(small_t<size_t>::type const value) { this->_offset = (value << 1) | (this->_offset & 1U); }
		unsigned char length;
	};
	friend struct std::is_scalar<NameInfo>;
	struct LinkInfo
	{
		LinkInfo() : next_entry(negative_one) { this->name.offset(negative_one); }
		typedef small_t<size_t>::type next_entry_type; next_entry_type next_entry;
		NameInfo name;
		unsigned int parent;
	};
	friend struct std::is_scalar<LinkInfo>;
	struct StreamInfo : SizeInfo
	{
		StreamInfo() : SizeInfo(), next_entry(), name(), type_name_id() { }
		typedef small_t<size_t>::type next_entry_type; next_entry_type next_entry;
		NameInfo name;
		unsigned char is_sparse : 1;
		unsigned char is_allocated_size_accounted_for_in_main_stream : 1;
		unsigned char type_name_id : CHAR_BIT - 2 /* zero if and only if $I30:$INDEX_ROOT or $I30:$INDEX_ALLOCATION */;
	};
	friend struct std::is_scalar<StreamInfo>;
	typedef std::codecvt<std::tstring::value_type, char, int /*std::mbstate_t*/> CodeCvt;
	typedef vector_with_fast_size<LinkInfo> LinkInfos;
	typedef vector_with_fast_size<StreamInfo> StreamInfos;
	struct Record;
	typedef vector_with_fast_size<Record> Records;
	typedef std::vector<unsigned int> RecordsLookup;
	struct ChildInfo
	{
		ChildInfo() : next_entry(negative_one), record_number(negative_one), name_index(negative_one) { }
		typedef small_t<size_t>::type next_entry_type; next_entry_type next_entry;
		small_t<Records::size_type>::type record_number;
		unsigned short name_index;
	};
	typedef vector_with_fast_size<ChildInfo> ChildInfos;
	struct Record
	{
		StandardInfo stdinfo;
		unsigned short name_count /* <= 1024 < 2048 */, stream_count /* <= 4106? < 8192 */;
		ChildInfos::value_type::next_entry_type first_child;
		LinkInfos::value_type first_name;
		StreamInfos::value_type first_stream;
		Record() : stdinfo(), name_count(), stream_count(), first_child(negative_one), first_name(), first_stream()
		{
			this->first_stream.name.offset(negative_one);
			this->first_stream.next_entry = negative_one;
		}
	};
#pragma pack(pop)
	friend struct std::is_scalar<Record>;
	mutable atomic_namespace::recursive_mutex _mutex;
	value_initialized<clock_t> _tbegin;
	value_initialized<bool> _init_called;
	std::tvstring _root_path;
	Handle _volume;
	std::tvstring names;
	Records records_data;
	RecordsLookup records_lookup;
	LinkInfos nameinfos;
	StreamInfos streaminfos;
	ChildInfos childinfos;
	Handle _finished_event;
	atomic_namespace::atomic<unsigned int> _finished;
	atomic_namespace::atomic<size_t> _total_names_and_streams;
	value_initialized<unsigned int> _expected_records;
	atomic_namespace::atomic<bool> _cancelled;
	atomic_namespace::atomic<unsigned int> _records_so_far, _preprocessed_so_far;
	std::vector<Speed> _perf_reports_circ /* circular buffer */; value_initialized<size_t> _perf_reports_begin;
	atomic_namespace::spin_atomic<Speed> _perf_avg_speed;
#pragma pack(push, 1)
	struct key_type_internal
	{
		// max 1023 hardlinks
		// max 4107 streams
		enum { name_info_bits = 10, stream_info_bits = 13, index_bits = sizeof(unsigned int) * CHAR_BIT - (name_info_bits + stream_info_bits)  };
		typedef unsigned int frs_type;
		typedef unsigned short name_info_type;
		typedef unsigned short stream_info_type;
		typedef unsigned short index_type;
		frs_type frs() const { frs_type const result = this->_frs; return result; }
		name_info_type name_info() const { name_info_type const result = this->_name_info; return result == ((static_cast<name_info_type>(1) << name_info_bits) - 1) ? ~name_info_type() : result; }
		name_info_type stream_info() const { stream_info_type const result = this->_stream_info; return result == ((static_cast<stream_info_type>(1) << stream_info_bits) - 1) ? ~stream_info_type() : result; }
		void stream_info(name_info_type const value) { this->_stream_info = value; }
		index_type index() const { index_type const result = this->_index; return result == ((static_cast<index_type>(1) << index_bits) - 1) ? ~index_type() : result; }
		void index(name_info_type const value) { this->_index = value; }
		explicit key_type_internal(frs_type const frs, name_info_type const name_info, stream_info_type const stream_info)
			: _frs(frs), _name_info(name_info), _stream_info(stream_info), _index(negative_one) { }
		bool operator==(key_type_internal const &other) const { return this->_frs == other._frs && this->_name_info == other._name_info && this->_stream_info == other._stream_info; }
	private:
		frs_type _frs;
		name_info_type _name_info : name_info_bits;
		stream_info_type _stream_info : stream_info_bits;
		index_type _index : index_bits;
	};
#pragma pack(pop)

	struct mapping_pair_iterator
	{
		typedef mapping_pair_iterator this_type;
		typedef long long vcn_type, lcn_type;
		struct value_type { value_type(vcn_type const next_vcn, lcn_type const current_lcn) : next_vcn(next_vcn), current_lcn(current_lcn) { } vcn_type next_vcn; lcn_type current_lcn; };
		explicit mapping_pair_iterator(ntfs::ATTRIBUTE_RECORD_HEADER const *const ah, size_t const max_length = ~size_t(), lcn_type const current_lcn = lcn_type()) :
			mapping_pairs(reinterpret_cast<unsigned char const *>(ah) + static_cast<ptrdiff_t>(ah->NonResident.MappingPairsOffset)),
			ah_end(reinterpret_cast<unsigned char const *>(ah) + (ah->Length < max_length ? ah->Length : static_cast<ptrdiff_t>(max_length))),
			j(0),
			value(ah->NonResident.LowestVCN, current_lcn)
		{
		}
		bool is_final() const { return !(mapping_pairs[j] && &mapping_pairs[j] < ah_end); }
		value_type const &operator *() const { return this->value; }
		value_type const *operator->() const { return &**this; }
		this_type &operator++()
		{
			unsigned char const lv = mapping_pairs[j++];
			{
				unsigned char v = static_cast<unsigned char>(lv & ((1U << (CHAR_BIT / 2)) - 1));
				vcn_type delta = v && (mapping_pairs[j + v - 1] >> (CHAR_BIT - 1)) ? ~vcn_type() << (v * CHAR_BIT) : vcn_type();
				for (unsigned char k = 0; k != v; ++k) { delta |= static_cast<vcn_type>(mapping_pairs[j++]) << (CHAR_BIT * k); }
				value.next_vcn += delta;
			}
			{
				unsigned char l = static_cast<unsigned char>(lv >> (CHAR_BIT / 2));
				lcn_type delta = l && (mapping_pairs[j + l - 1] >> (CHAR_BIT - 1)) ? ~lcn_type() << (l * CHAR_BIT) : lcn_type();
				for (unsigned char k = 0; k != l; ++k) { delta |= static_cast<lcn_type>(mapping_pairs[j++]) << (CHAR_BIT * k); }
				value.current_lcn += delta;
			}
			return *this;
		}
	private:
		unsigned char const *mapping_pairs, *ah_end;
		size_t j;
		value_type value;
	};

	Records::iterator at(size_t const frs, Records::iterator *const existing_to_revalidate = NULL)
	{
		if (frs >= this->records_lookup.size())
		{ this->records_lookup.resize(frs + 1, ~RecordsLookup::value_type()); }
		RecordsLookup::iterator const k = this->records_lookup.begin() + static_cast<ptrdiff_t>(frs);
		if (!~*k)
		{
			ptrdiff_t const j = (existing_to_revalidate ? *existing_to_revalidate : this->records_data.end()) - this->records_data.begin();
			*k = static_cast<unsigned int>(this->records_data.size());
			this->records_data.resize(this->records_data.size() + 1);
			if (existing_to_revalidate) { *existing_to_revalidate = this->records_data.begin() + j; }
		}
		return this->records_data.begin() + static_cast<ptrdiff_t>(*k);
	}

	template<class Me>
	static typename propagate_const<Me, Records::value_type>::type *_find(Me *const me, key_type_internal::frs_type const frs)
	{
		typedef typename propagate_const<Me, Records::value_type>::type *pointer_type;
		pointer_type result;
		if (frs < me->records_lookup.size())
		{
			RecordsLookup::value_type const islot = me->records_lookup[frs];
			// The complicated logic here is to remove the 'imul' instruction...
			result = fast_subscript(me->records_data.begin(), islot);
		}
		else
		{
			result = me->records_data.empty() ? NULL : &*(me->records_data.end() - 1) + 1;
		}
		return result;
	}

	Records::value_type *find(key_type_internal::frs_type const frs) { return this->_find(this, frs); }
	Records::value_type const *find(key_type_internal::frs_type const frs) const { return this->_find(this, frs); }

	ChildInfos::value_type *childinfo(Records::value_type *const i) { return this->childinfo(i->first_child); }
	ChildInfos::value_type const *childinfo(Records::value_type const *const i) const { return this->childinfo(i->first_child); }
	ChildInfos::value_type *childinfo(ChildInfo::next_entry_type const i) { return !~i ? NULL : fast_subscript(this->childinfos.begin(), i); }
	ChildInfos::value_type const *childinfo(ChildInfo::next_entry_type const i) const { return !~i ? NULL : fast_subscript(this->childinfos.begin(), i); }
	LinkInfos::value_type *nameinfo(LinkInfo::next_entry_type const i) { return !~i ? NULL : fast_subscript(this->nameinfos.begin(), i); }
	LinkInfos::value_type const *nameinfo(LinkInfo::next_entry_type const i) const { return !~i ? NULL : fast_subscript(this->nameinfos.begin(), i); }
	LinkInfos::value_type *nameinfo(Records::value_type *const i) { return ~i->first_name.name.offset() ? &i->first_name : NULL; }
	LinkInfos::value_type const *nameinfo(Records::value_type const *const i) const { return ~i->first_name.name.offset() ? &i->first_name : NULL; }
	StreamInfos::value_type *streaminfo(StreamInfo::next_entry_type const i) { return !~i ? NULL : fast_subscript(this->streaminfos.begin(), i); }
	StreamInfos::value_type const *streaminfo(StreamInfo::next_entry_type const i) const { return !~i ? NULL : fast_subscript(this->streaminfos.begin(), i); }
	StreamInfos::value_type *streaminfo(Records::value_type *const i) { assert(~i->first_stream.name.offset() || (!i->first_stream.name.length && !i->first_stream.length)); return ~i->first_stream.name.offset() ? &i->first_stream : NULL; }
	StreamInfos::value_type const *streaminfo(Records::value_type const *const i) const { assert(~i->first_stream.name.offset() || (!i->first_stream.name.length && !i->first_stream.length)); return ~i->first_stream.name.offset() ? &i->first_stream : NULL; }
public:
	typedef key_type_internal key_type;
	typedef StandardInfo standard_info;
	typedef NameInfo name_info;
	typedef SizeInfo size_info;
	atomic_namespace::atomic<long long> reserved_clusters;
	value_initialized<long long> mft_zone_start, mft_zone_end;
	value_initialized<unsigned int> cluster_size;
	value_initialized<unsigned int> mft_record_size;
	value_initialized<unsigned int> mft_capacity;
	NtfsIndex(std::tvstring value) : _root_path(value), _finished_event(CreateEvent(NULL, TRUE, FALSE, NULL)), _finished(), _total_names_and_streams(0), _cancelled(false), _records_so_far(0), _preprocessed_so_far(0), _perf_reports_circ(1 << 6), _perf_avg_speed(Speed()), reserved_clusters(0)
	{
	}
	~NtfsIndex()
	{
	}
	bool init_called() const { return this->_init_called; }
	void init()
	{
		this->_init_called = true;
		std::tvstring path_name = this->_root_path;
		deldirsep(path_name);
		if (!path_name.empty() && *path_name.begin() != _T('\\') && *path_name.begin() != _T('/')) { path_name.insert(static_cast<size_t>(0), _T("\\\\.\\")); }
		HANDLE const h = CreateFile(path_name.c_str(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
		CheckAndThrow(h != INVALID_HANDLE_VALUE);
		Handle volume(h);
		winnt::IO_STATUS_BLOCK iosb;
		struct : winnt::FILE_FS_ATTRIBUTE_INFORMATION { unsigned char buf[MAX_PATH]; } info = {};
		winnt::NTSTATUS status = winnt::NtQueryVolumeInformationFile(volume.value, &iosb, &info, sizeof(info), 5);
		if (status != 0) { CppRaiseException(winnt::RtlNtStatusToDosError(status)); }
		if (info.FileSystemNameLength != 4 * sizeof(*info.FileSystemName) || std::char_traits<TCHAR>::compare(info.FileSystemName, _T("NTFS"), 4))
		{ CppRaiseException(ERROR_UNRECOGNIZED_VOLUME); }
		if (false) { IoPriority::set(reinterpret_cast<uintptr_t>(volume.value), winnt::IoPriorityLow); }
		volume.swap(this->_volume);
		this->_tbegin = clock();
	}
	void set_finished(unsigned int const &result)
	{
		SetEvent(this->_finished_event);
		this->_finished = result;
	}
	NtfsIndex *unvolatile() volatile { return const_cast<NtfsIndex *>(this); }
	NtfsIndex const *unvolatile() const volatile { return const_cast<NtfsIndex *>(this); }
	size_t total_names_and_streams() const { return this->_total_names_and_streams.load(atomic_namespace::memory_order_relaxed); }
	size_t total_names_and_streams() const volatile { return this->_total_names_and_streams.load(atomic_namespace::memory_order_acquire); }
	size_t total_names() const { return this->nameinfos.size(); }
	size_t expected_records() const { return this->_expected_records; }
	size_t preprocessed_so_far() const volatile { return this->_preprocessed_so_far.load(atomic_namespace::memory_order_acquire); }
	size_t preprocessed_so_far() const { return this->_preprocessed_so_far.load(atomic_namespace::memory_order_relaxed); }
	size_t records_so_far() const volatile { return this->_records_so_far.load(atomic_namespace::memory_order_acquire); }
	size_t records_so_far() const { return this->_records_so_far.load(atomic_namespace::memory_order_relaxed); }
	void *volume() const volatile { return this->_volume.value; }
	atomic_namespace::recursive_mutex &get_mutex() const volatile { return this->unvolatile()->_mutex; }
	Speed speed() const volatile
	{
		Speed total;
		total = this->_perf_avg_speed.load(atomic_namespace::memory_order_acquire);
		return total;
	}
	std::tvstring const &root_path() const volatile { return const_cast<std::tvstring const &>(this->_root_path); }
	unsigned int get_finished() const volatile
	{
		return this->_finished.load();
	}
	bool cancelled() const volatile
	{
		this_type const *const me = this->unvolatile();
		return me->_cancelled.load(atomic_namespace::memory_order_acquire);
	}
	void cancel() volatile
	{
		this_type *const me = this->unvolatile();
		me->_cancelled.store(true, atomic_namespace::memory_order_release);
	}
	uintptr_t finished_event() const
	{
		return reinterpret_cast<uintptr_t>(this->_finished_event.value);
	}
	void reserve(unsigned int records)
	{
		this->_expected_records = records;
		try
		{
			if (this->records_lookup.size() < records)
			{
				this->nameinfos.reserve(records + records / 16);
				this->streaminfos.reserve(records / 4);
				this->childinfos.reserve(records + records / 2);
				this->names.reserve(records * 23);
				this->records_lookup.resize(records, ~RecordsLookup::value_type());
				this->records_data.reserve(records + records / 4);
			}
		}
		catch (std::bad_alloc &) { }
	}
	void preload_concurrent(unsigned long long const virtual_offset, void *const buffer, size_t const size) volatile
	{
		unsigned int max_frs_plus_one = 0;
		unsigned int const mft_record_size = this->mft_record_size;
		unsigned int mft_record_size_log2 = 0;
		for (;;) { unsigned int const v = mft_record_size_log2 + 1; if (!(mft_record_size >> v)) { break; } mft_record_size_log2 = v; }
		assert((1U << mft_record_size_log2) == mft_record_size && "MFT record size not a power of 2");
		unsigned int const mft_record_size_pow2_mod_mask = mft_record_size - 1;
		for (size_t i = virtual_offset & mft_record_size_pow2_mod_mask /* this should only occur if cluster size < MFT record size */ ? mft_record_size - virtual_offset & mft_record_size_pow2_mod_mask : 0;
			i + mft_record_size <= size;
			i += mft_record_size)
		{
			unsigned int const frs = static_cast<unsigned int>((virtual_offset + i) >> mft_record_size_log2);
			ntfs::FILE_RECORD_SEGMENT_HEADER *const frsh = reinterpret_cast<ntfs::FILE_RECORD_SEGMENT_HEADER *>(&static_cast<unsigned char *>(buffer)[i]);
			if (frsh->MultiSectorHeader.Magic == 'ELIF')
			{
				if (frsh->MultiSectorHeader.unfixup(mft_record_size))
				{
					unsigned int const frs_base = frsh->BaseFileRecordSegment ? static_cast<unsigned int>(frsh->BaseFileRecordSegment) : frs;
					if (max_frs_plus_one < frs_base + 1) { max_frs_plus_one = frs_base + 1; }
				}
				else
				{
					frsh->MultiSectorHeader.Magic = 'DAAB';
				}
			}
		}
		if (max_frs_plus_one > 0)
		{
			// Ensure the vector is only reallocated once this iteration, if possible
			lock(this)->at(max_frs_plus_one - 1);
		}
	}
	void load(unsigned long long const virtual_offset, void *const buffer, size_t const size, unsigned long long const skipped_begin, unsigned long long const skipped_end)
	{
		unsigned int const mft_record_size = this->mft_record_size;
		unsigned int mft_record_size_log2 = 0;
		for (;;) { unsigned int const v = mft_record_size_log2 + 1; if (!(mft_record_size >> v)) { break; } mft_record_size_log2 = v; }
		assert((1U << mft_record_size_log2) == mft_record_size && "MFT record size not a power of 2");
		unsigned int const mft_record_size_pow2_mod_mask = mft_record_size - 1;
		if (size % mft_record_size)
		{ throw std::runtime_error("Cluster size is smaller than MFT record size; split MFT records (over multiple clusters) not supported. Defragmenting your MFT may sometimes avoid this condition."); }
		if (skipped_begin || skipped_end) { this->_records_so_far.fetch_add(static_cast<unsigned int>((skipped_begin + skipped_end) >> mft_record_size_log2)); }
		ChildInfo const empty_child_info;
		for (size_t i = virtual_offset & mft_record_size_pow2_mod_mask /* this should only occur if cluster size < MFT record size */ ? mft_record_size - virtual_offset & mft_record_size_pow2_mod_mask : 0;
			i + mft_record_size <= size;
			i += mft_record_size, this->_records_so_far.fetch_add(1, atomic_namespace::memory_order_acq_rel))
		{
			unsigned int const frs = static_cast<unsigned int>((virtual_offset + i) >> mft_record_size_log2);
			ntfs::FILE_RECORD_SEGMENT_HEADER *const frsh = reinterpret_cast<ntfs::FILE_RECORD_SEGMENT_HEADER *>(&static_cast<unsigned char *>(buffer)[i]);
			if (frsh->MultiSectorHeader.Magic == 'ELIF' && !!(frsh->Flags & ntfs::FRH_IN_USE))
			{
				unsigned int const frs_base = frsh->BaseFileRecordSegment ? static_cast<unsigned int>(frsh->BaseFileRecordSegment) : frs;
				Records::iterator base_record = this->at(frs_base);
				void const *const frsh_end = frsh->end(mft_record_size);
				for (ntfs::ATTRIBUTE_RECORD_HEADER const
					*ah = frsh->begin(); ah < frsh_end && ah->Type != ntfs::AttributeTypeCode() && ah->Type != ntfs::AttributeEnd; ah = ah->next())
				{
					switch (ah->Type)
					{
					case ntfs::AttributeStandardInformation:
						if (ntfs::STANDARD_INFORMATION const *const fn = static_cast<ntfs::STANDARD_INFORMATION const *>(ah->Resident.GetValue()))
						{
							base_record->stdinfo.created = fn->CreationTime;
							base_record->stdinfo.written = fn->LastModificationTime;
							base_record->stdinfo.accessed = fn->LastAccessTime;
							base_record->stdinfo.attributes(fn->FileAttributes | ((frsh->Flags & ntfs::FRH_DIRECTORY) ? FILE_ATTRIBUTE_DIRECTORY : 0));
						}
						break;
					case ntfs::AttributeFileName:
						if (ntfs::FILENAME_INFORMATION const *const fn = static_cast<ntfs::FILENAME_INFORMATION const *>(ah->Resident.GetValue()))
						{
							unsigned int const frs_parent = static_cast<unsigned int>(fn->ParentDirectory);
							if (fn->Flags != 0x02 /* FILE_NAME_DOS */)
							{
								if (LinkInfos::value_type *const si = this->nameinfo(&*base_record))
								{
									size_t const link_index = this->nameinfos.size();
									this->nameinfos.push_back(base_record->first_name);
									base_record->first_name.next_entry = static_cast<LinkInfos::value_type::next_entry_type>(link_index);
								}
								LinkInfo *const info = &base_record->first_name;
								info->name.offset(static_cast<unsigned int>(this->names.size()));
								info->name.length = static_cast<unsigned char>(fn->FileNameLength);
								bool const ascii = is_ascii(fn->FileName, fn->FileNameLength);
								info->name.ascii(ascii);
								info->parent = frs_parent;
								append_directional(this->names, fn->FileName, fn->FileNameLength, ascii ? 1 : 0);
								if (frs_parent != frs_base)
								{
									Records::iterator const parent = this->at(frs_parent, &base_record);
									size_t const child_index = this->childinfos.size();
									this->childinfos.push_back(empty_child_info);
									ChildInfo *const child_info = &this->childinfos.back();
									child_info->record_number = frs_base;
									child_info->name_index = base_record->name_count;
									child_info->next_entry = parent->first_child;
									parent->first_child = static_cast<ChildInfos::value_type::next_entry_type>(child_index);
								}
								this->_total_names_and_streams.fetch_add(base_record->stream_count, atomic_namespace::memory_order_acq_rel);
								++base_record->name_count;
							}
						}
						break;
					// case ntfs::AttributeAttributeList:
					// case ntfs::AttributeLoggedUtilityStream:
					case ntfs::AttributeObjectId:
					// case ntfs::AttributeSecurityDescriptor:
					case ntfs::AttributePropertySet:
					case ntfs::AttributeBitmap:
					case ntfs::AttributeIndexAllocation:
					case ntfs::AttributeIndexRoot:
					case ntfs::AttributeData:
					case ntfs::AttributeReparsePoint:
					case ntfs::AttributeEA:
					case ntfs::AttributeEAInformation:
					default:
					{
						if (ah->IsNonResident)
						{
							mapping_pair_iterator mpi(ah, reinterpret_cast<unsigned char const *>(frsh_end) - reinterpret_cast<unsigned char const *>(ah));
							for (mapping_pair_iterator::vcn_type current_vcn = mpi->next_vcn; !mpi.is_final(); )
							{
								++mpi;
								if (mpi->current_lcn)
								{
									mapping_pair_iterator::lcn_type
										intersect_mft_zone_begin = this->mft_zone_start,
										intersect_mft_zone_end = this->mft_zone_end;
									if (intersect_mft_zone_begin < current_vcn) { intersect_mft_zone_begin = current_vcn; }
									if (intersect_mft_zone_end >= mpi->next_vcn) { intersect_mft_zone_end = mpi->next_vcn; }
									if (intersect_mft_zone_begin < intersect_mft_zone_end)
									{
										this->reserved_clusters.fetch_sub(intersect_mft_zone_end - intersect_mft_zone_begin);
									}
								}
								current_vcn = mpi->next_vcn;
							}
						}
						bool const is_primary_attribute = !(ah->IsNonResident && ah->NonResident.LowestVCN);
						if (is_primary_attribute)
						{
							bool const isdir = (ah->Type == ntfs::AttributeBitmap || ah->Type == ntfs::AttributeIndexRoot || ah->Type == ntfs::AttributeIndexAllocation) && ah->NameLength == 4 && memcmp(ah->name(), _T("$I30"), sizeof(*ah->name()) * 4) == 0;
							unsigned char const name_length = isdir ? static_cast<unsigned char>(0) : ah->NameLength;
							unsigned char const type_name_id = static_cast<unsigned char>(isdir ? 0 : ah->Type >> (CHAR_BIT / 2));
							StreamInfo *info = NULL;
							if (StreamInfos::value_type *const si = this->streaminfo(&*base_record))
							{
								if (isdir)  // Do we want to merge this with another attribute? (e.g. AttributeIndexAllocation with AttributeIndexRoot, or secondary entry with primary entry)
								{
									for (StreamInfos::value_type *k = si; k; k = this->streaminfo(k->next_entry))
									{
										if (k->type_name_id == type_name_id && k->name.length == name_length &&
											(name_length == 0 || std::equal(ah->name(), ah->name() + static_cast<ptrdiff_t>(ah->NameLength), this->names.begin() + static_cast<ptrdiff_t>(k->name.offset()))))
										{
											info = k;
											break;
										}
									}
								}
								if (!info)
								{
									size_t const stream_index = this->streaminfos.size();
									this->streaminfos.push_back(*si);
									si->next_entry = static_cast<small_t<size_t>::type>(stream_index);
								}
							}
							if (!info)
							{
								info = &base_record->first_stream;
								info->allocated = 0;  // We have to initialize this because we add to it later
								info->length = 0;  // We have to initialize this because we add to it later
								info->bulkiness = 0;  // We have to initialize this because we add to it later
								info->treesize = 0;  // We have to initialize this because we add to it later
								// We also have to initialize the name because it _identifies_ the attribute
								info->is_sparse = 0;
								info->is_allocated_size_accounted_for_in_main_stream = 0;
								info->type_name_id = type_name_id;
								info->name.length = name_length;
								if (isdir)
								{
									// Suppress name
									info->name.offset(0);
								}
								else
								{
									info->name.offset(static_cast<unsigned int>(this->names.size()));
									bool const ascii = is_ascii(ah->name(), ah->NameLength);
									info->name.ascii(ascii);
									append_directional(this->names, ah->name(), ah->NameLength, ascii ? 1 : 0);
								}
								++base_record->stream_count;
								this->_total_names_and_streams.fetch_add(base_record->name_count, atomic_namespace::memory_order_acq_rel);
							}
							bool const is_badclus_bad = frs_base == 0x000000000008 && ah->NameLength == 4 && memcmp(ah->name(), _T("$Bad"), sizeof(*ah->name()) * 4) == 0;
							bool const is_sparse = !!(ah->Flags & 0x8000);
							if (is_sparse)
							{ info->is_sparse |= 0x1; }

							info->allocated += ah->IsNonResident
								? ah->NonResident.CompressionUnit
								? static_cast<file_size_type>(ah->NonResident.CompressedSize)
								: static_cast<file_size_type>(is_badclus_bad /* $BadClus */
									? ah->NonResident.InitializedSize /* actually this is still wrong... should be looking at VCNs */
									: ah->NonResident.AllocatedSize)
								: 0;

							info->length += ah->IsNonResident ? static_cast<file_size_type>(is_badclus_bad /* $BadClus */ ? ah->NonResident.InitializedSize /* actually this is still wrong... */ : ah->NonResident.DataSize) : ah->Resident.ValueLength;
							info->bulkiness += info->allocated;
							info->treesize = isdir;
						}
						break;
					}
					}
				}
				// fprintf(stderr, "%llx\n", frsh->BaseFileRecordSegment);
			}
		}
		unsigned int const records_so_far = this->_records_so_far.load(atomic_namespace::memory_order_acquire);
		bool const finished = records_so_far >= this->mft_capacity;
		if (finished && !this->_root_path.empty())
		{
			TCHAR buf[2048];
			size_t names_wasted_chars = 0;
			for (size_t i = 0; i != this->names.size(); ++i)
			{
				if ((this->names[i] | SCHAR_MAX) == SCHAR_MAX)
				{
					++names_wasted_chars;
				}
			}
			int const nbuf = safe_stprintf(buf,
				_T("%s\trecords_data\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\n")
				_T("%s\trecords_lookup\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\n")
				_T("%s\tnames\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\t%8I64u bytes wasted\n")
				_T("%s\tnameinfos\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\n")
				_T("%s\tstreaminfos\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\n")
				_T("%s\tchildinfos\twidth = %2u\tsize = %8I64u\tcapacity = %8I64u\n"),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->records_data  .begin())), static_cast<unsigned long long>(this->records_data  .size()), static_cast<unsigned long long>(this->records_data  .capacity()),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->records_lookup.begin())), static_cast<unsigned long long>(this->records_lookup.size()), static_cast<unsigned long long>(this->records_lookup.capacity()),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->names         .begin())), static_cast<unsigned long long>(this->names         .size()), static_cast<unsigned long long>(this->names         .capacity()), static_cast<unsigned long long>(names_wasted_chars),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->nameinfos     .begin())), static_cast<unsigned long long>(this->nameinfos     .size()), static_cast<unsigned long long>(this->nameinfos     .capacity()),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->streaminfos   .begin())), static_cast<unsigned long long>(this->streaminfos   .size()), static_cast<unsigned long long>(this->streaminfos   .capacity()),
				this->_root_path.c_str(), static_cast<unsigned>(sizeof(*this->childinfos    .begin())), static_cast<unsigned long long>(this->childinfos    .size()), static_cast<unsigned long long>(this->childinfos    .capacity()));
			if (nbuf > 0) { OutputDebugString(buf); }
			struct
			{
				typedef SizeInfo PreprocessResult;
				NtfsIndex *me;
				typedef std::vector<unsigned long long> Scratch;
				Scratch scratch;
				size_t depth;
				PreprocessResult operator()(Records::value_type *const fr, key_type::name_info_type const name_info, unsigned short const total_names)
				{
					size_t const old_scratch_size = scratch.size();
					PreprocessResult result;
					if (fr)
					{
						PreprocessResult children_size;
						++depth;
						for (ChildInfos::value_type *i = me->childinfo(fr); i && ~i->record_number; i = me->childinfo(i->next_entry))
						{
							Records::value_type *const fr2 = me->find(i->record_number);
							if (fr2 != fr)  /* root directory is the only one that is a child of itself */
							{
								PreprocessResult const
									subresult = this->operator()(fr2, fr2->name_count - static_cast<size_t>(1) - i->name_index, fr2->name_count);
								scratch.push_back(subresult.bulkiness);
								children_size.length += subresult.length;
								children_size.allocated += subresult.allocated;
								children_size.bulkiness += subresult.bulkiness;
								children_size.treesize += subresult.treesize;
							}
						}
						--depth;
						std::make_heap(scratch.begin() + static_cast<ptrdiff_t>(old_scratch_size), scratch.end());
						unsigned long long const threshold = children_size.allocated / 100;
						// Algorithm: All files whose sizes are < X% of the current folder's size are assumed to contribute to the folder's bulkiness.
						for (Scratch::iterator i = scratch.end(); i != scratch.begin() + static_cast<ptrdiff_t>(old_scratch_size); )
						{
							std::pop_heap(scratch.begin() + static_cast<ptrdiff_t>(old_scratch_size), i);
							--i;
							if (*i < threshold) { break; }
							children_size.bulkiness = children_size.bulkiness - *i;
						}
						if (depth == 0)
						{
							children_size.allocated += static_cast<unsigned long long>(me->reserved_clusters) * me->cluster_size;
						}
						result = children_size;
						struct Accumulator
						{
							static unsigned long long delta_impl(unsigned long long const value, unsigned short const i, unsigned short const n)
							{
								return value * (i + 1) / n - value * i / n;
							}
							static unsigned long long delta(unsigned long long const value, unsigned short const i, unsigned short const n)
							{
								return n != 1 ? n != 2 ? delta_impl(value, i, n) : i != 1 ? delta_impl(value, ((void)(assert(i == 0)), 0), n) : delta_impl(value, i, n) : delta_impl(value, ((void)(assert(i == 0)), 0), n);
							}
						};
						StreamInfos::value_type *default_stream = NULL, *compressed_default_stream_to_merge = NULL;
						unsigned long long default_allocated_delta = 0, compressed_default_allocated_delta = 0;
						for (StreamInfos::value_type *k = me->streaminfo(fr); k; k = me->streaminfo(k->next_entry))
						{
							bool const is_data_attribute = (k->type_name_id << (CHAR_BIT / 2)) == ntfs::AttributeData;
							bool const is_default_stream = is_data_attribute && !k->name.length;
							unsigned long long const
								allocated_delta = Accumulator::delta(k->is_allocated_size_accounted_for_in_main_stream ? static_cast<file_size_type>(0) : k->allocated, name_info, total_names),
								bulkiness_delta = Accumulator::delta(k->bulkiness, name_info, total_names);
							if (is_default_stream)
							{
								default_stream = k;
								default_allocated_delta += allocated_delta;
							}
							bool const is_compression_reparse_point = is_data_attribute
								&& k->name.length
								&& (
									k->name.ascii()
									? memcmp(reinterpret_cast< char   const *>(&me->names[k->name.offset()]),  "WofCompressedData", 17 * sizeof( char  )) == 0
									: memcmp(reinterpret_cast<wchar_t const *>(&me->names[k->name.offset()]), L"WofCompressedData", 17 * sizeof(wchar_t)) == 0
									);
							unsigned long long const
								length_delta = Accumulator::delta(is_compression_reparse_point ? static_cast<file_size_type>(0) : k->length, name_info, total_names);
							if (is_compression_reparse_point)
							{
								if (!k->is_allocated_size_accounted_for_in_main_stream)
								{
									compressed_default_stream_to_merge = k;
									compressed_default_allocated_delta += allocated_delta;
								}
							}
							result.length += length_delta;
							result.allocated += allocated_delta;
							result.bulkiness += bulkiness_delta;
							result.treesize += 1;
							if (!k->type_name_id)
							{
								k->length += children_size.length;
								k->allocated += children_size.allocated;
								k->bulkiness += children_size.bulkiness;
								k->treesize += children_size.treesize;
							}
							me->_preprocessed_so_far.fetch_add(1, atomic_namespace::memory_order_acq_rel);
						}
						if (compressed_default_stream_to_merge && default_stream)
						{
							compressed_default_stream_to_merge->is_allocated_size_accounted_for_in_main_stream = 1;
							default_stream->allocated += compressed_default_stream_to_merge->allocated;
							result.allocated -= default_allocated_delta;
							result.allocated -= compressed_default_allocated_delta;
							result.allocated += Accumulator::delta(default_stream->allocated, name_info, total_names);
						}
					}
					scratch.erase(scratch.begin() + static_cast<ptrdiff_t>(old_scratch_size), scratch.end());
					return result;
				}
			} preprocessor = { this };
			clock_t const tbefore_preprocess = clock();
			preprocessor(this->find(0x000000000005), 0, 1);
			clock_t const tfinish = clock();
			Handle().swap(this->_volume);
			if (false)
			{
				_ftprintf(stderr, _T("Finished: %s (%I64u ms total, %I64u ms preprocessing)\n"), this->_root_path.c_str(), (tfinish - this->_tbegin) * 1000ULL / CLOCKS_PER_SEC, (tfinish - tbefore_preprocess) * 1000ULL / CLOCKS_PER_SEC);
			}
		}
		finished ? SetEvent(this->_finished_event) : ResetEvent(this->_finished_event);
	}

	void report_speed(unsigned long long const size, clock_t const tfrom, clock_t const tto)
	{
		clock_t const duration = tto - tfrom;
		Speed const speed(size, duration);
		this->_perf_avg_speed.fetch_add(speed, atomic_namespace::memory_order_acq_rel);
		Speed const prev = this->_perf_reports_circ[this->_perf_reports_begin];
		this->_perf_reports_circ[this->_perf_reports_begin] = speed;
		this->_perf_reports_begin = (this->_perf_reports_begin + 1) % this->_perf_reports_circ.size();
	}

	struct file_pointers
	{
		Records::value_type const *record;
		LinkInfos::value_type const *link;
		StreamInfos::value_type const *stream;
		key_type parent() const
		{
			return key_type(link->parent /* ... | 0 | 0 (since we want the first name of all ancestors)*/, static_cast<key_type::name_info_type>(~key_type::name_info_type()), static_cast<key_type::stream_info_type>(~key_type::stream_info_type()));
		}
	};

	file_pointers get_file_pointers(key_type key) const
	{
		bool wait_for_finish = false;  // has performance penalty
		if (wait_for_finish && WaitForSingleObject(this->_finished_event, 0) == WAIT_TIMEOUT) { throw std::logic_error("Need to wait for indexing to be finished"); }
		file_pointers result;
		result.record = NULL;
		if (~key.frs())
		{
			Records::value_type const *const fr = this->find(key.frs());
			unsigned short ji = 0;
			for (LinkInfos::value_type const *j = this->nameinfo(fr); j; j = this->nameinfo(j->next_entry), ++ji)
			{
				key_type::name_info_type const name_info = key.name_info();
				if (name_info == USHRT_MAX || ji == name_info)
				{
					unsigned short ki = 0;
					for (StreamInfos::value_type const *k = this->streaminfo(fr); k; k = this->streaminfo(k->next_entry), ++ki)
					{
						key_type::stream_info_type const stream_info = key.stream_info();
						if (stream_info == USHRT_MAX ? !k->type_name_id : ki == stream_info)
						{
							result.record = fr;
							result.link = j;
							result.stream = k;
							goto STOP;
						}
					}
				}
			}
		STOP:
			if (!result.record)
			{
				throw std::logic_error("could not find a file attribute");
			}
		}
		return result;
	}

	class ParentIterator
	{
		typedef ParentIterator this_type;
		struct value_type_internal
		{
			void const *first;
			size_t second : sizeof(size_t) * CHAR_BIT - 1;
			size_t ascii : 1;
		};
		NtfsIndex const *index;
		key_type key;
		unsigned char state;
		unsigned short iteration;
		file_pointers ptrs;
		value_type_internal result;
		bool is_root() const
		{
			return key.frs() == 0x000000000005;
		}
		bool is_attribute() const
		{
			return ptrs.stream->type_name_id && (ptrs.stream->type_name_id << (CHAR_BIT / 2)) != ntfs::AttributeData;
		}
	public:
		typedef value_type_internal value_type;
		struct value_type_compare
		{
			bool operator()(value_type const &a, value_type const &b) const
			{
				bool result;
				if (a.ascii)
				{
					if (b.ascii)
					{
						result = std::lexicographical_compare(
							static_cast<char const *>(a.first), static_cast<char const *>(a.first) + static_cast<ptrdiff_t>(a.second),
							static_cast<char const *>(b.first), static_cast<char const *>(b.first) + static_cast<ptrdiff_t>(b.second));
					}
					else
					{
						result = std::lexicographical_compare(
							static_cast<char const *>(a.first), static_cast<char const *>(a.first) + static_cast<ptrdiff_t>(a.second),
							static_cast<wchar_t const *>(b.first), static_cast<wchar_t const *>(b.first) + static_cast<ptrdiff_t>(b.second));
					}
				}
				else
				{
					if (b.ascii)
					{
						result = std::lexicographical_compare(
							static_cast<wchar_t const *>(a.first), static_cast<wchar_t const *>(a.first) + static_cast<ptrdiff_t>(a.second),
							static_cast<char const *>(b.first), static_cast<char const *>(b.first) + static_cast<ptrdiff_t>(b.second));
					}
					else
					{
						result = std::lexicographical_compare(
							static_cast<wchar_t const *>(a.first), static_cast<wchar_t const *>(a.first) + static_cast<ptrdiff_t>(a.second),
							static_cast<wchar_t const *>(b.first), static_cast<wchar_t const *>(b.first) + static_cast<ptrdiff_t>(b.second));
					}
				}
				return result;
			}
		};
		explicit ParentIterator(NtfsIndex const *const index, key_type const &key)
			: index(index), key(key), state(0), iteration(0)
		{
		}
		unsigned int attributes() { return ptrs.record->stdinfo.attributes(); }
		bool empty() const { return !this->index; }
		bool next() { return ++*this, !this->empty(); }
		value_type const &operator *() const { return this->result; }
		value_type const *operator->() const { return &this->result; }
		unsigned short icomponent() const { return this->iteration; }
		bool operator==(this_type const &other) const { return this->index == other.index && this->key == other.key && this->state == other.state; }
		bool operator!=(this_type const &other) const { return !(*this == other); }
		this_type &operator++()
		{
#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wimplicit-fallthrough"
#endif
			switch (state)
			{
				for (; ; )
				{
			case 0:;
					ptrs = index->get_file_pointers(key);
					if (!is_root())
					{
						if (!ptrs.stream->type_name_id)
						{
							result.first = _T("\\"); result.second = 1; result.ascii = false;
							if (result.second) { state = 1; break; }
			case 1:;
						}
					}
					if (!this->iteration)
					{
						if (is_attribute() && ptrs.stream->type_name_id < sizeof(ntfs::attribute_names) / sizeof(*ntfs::attribute_names))
						{
							result.first = ntfs::attribute_names[ptrs.stream->type_name_id].data; result.second = ntfs::attribute_names[ptrs.stream->type_name_id].size; result.ascii = false;
							if (result.second) { state = 2; break; }
			case 2:;
							result.first = _T(":"); result.second = 1; result.ascii = false;
							if (result.second) { state = 3; break; }
			case 3:;
						}
						if (ptrs.stream->name.length)
						{
							result.first = &index->names[ptrs.stream->name.offset()]; result.second = ptrs.stream->name.length; result.ascii = ptrs.stream->name.ascii();
							if (result.second) { state = 4; break; }
			case 4:;
						}
						if (ptrs.stream->name.length || is_attribute())
						{
							result.first = _T(":"); result.second = 1; result.ascii = false;
							if (result.second) { state = 5; break; }
			case 5:;
						}
					}
					if (!this->iteration || !is_root())
					{
						result.first = &index->names[ptrs.link->name.offset()]; result.second = ptrs.link->name.length; result.ascii = ptrs.link->name.ascii();
						if (result.second) { state = 6; break; }
					}
			case 6:;
					if (is_root()) { this->index = NULL; break; }
					state = 0;
					key = ptrs.parent();
					++this->iteration;
				}
			default:;
			}
#ifdef __clang__
#pragma clang diagnostic pop
#endif
			return *this;
		}
	};

	size_t get_path(key_type key, std::tvstring &result, bool const name_only, unsigned int *attributes = NULL) const
	{
		size_t const old_size = result.size();
		for (ParentIterator pi(this, key); pi.next() && !(name_only && pi.icomponent()); )
		{
			if (attributes) { *attributes = pi.attributes(); attributes = NULL; }
			TCHAR const *const s = static_cast<TCHAR const *>(pi->first);
			if (name_only || !(pi->second == 1 && (pi->ascii ? *static_cast<char const *>(static_cast<void const *>(s)) : *s) == _T('.')))
			{
				append_directional(result, s, pi->second, pi->ascii ? -1 : 0, true);
			}
		}
		std::reverse(result.begin() + static_cast<ptrdiff_t>(old_size), result.end());
		return result.size() - old_size;
	}

	size_info const &get_sizes(key_type const &key) const
	{
		StreamInfos::value_type const *k;
		Records::value_type const *const fr = this->find(key.frs());
		unsigned short ki = 0;
		for (k = this->streaminfo(fr); k; k = this->streaminfo(k->next_entry), ++ki)
		{
			if (ki == key.stream_info())
			{
				break;
			}
		}
		assert(k);
		return *k;
	}

	standard_info const &get_stdinfo(unsigned int const frn) const
	{
		return this->find(frn)->stdinfo;
	}

	template<class F>
	void matches(F func, std::tvstring &path, bool const match_paths, bool const match_streams, bool const match_attributes) const
	{
		Matcher<F &> matcher = { this, func, match_paths, match_streams, match_attributes, &path, 0 };
		return matcher(0x000000000005);
	}

private:
	template<class F>
	struct Matcher
	{
		NtfsIndex const *me;
		F func;
		bool match_paths;
		bool match_streams;
		bool match_attributes;
		std::tvstring *path;
		size_t basename_index_in_path;
		NameInfo name;
		size_t depth;

		void operator()(key_type::frs_type const frs)
		{
			if (frs < me->records_lookup.size())
			{
				TCHAR const dirsep = getdirsep();
				std::tvstring temp;
				Records::value_type const *const i = me->find(frs);
				unsigned short ji = 0;
				for (LinkInfos::value_type const *j = me->nameinfo(i); j; j = me->nameinfo(j->next_entry), ++ji)
				{
					size_t const old_basename_index_in_path = basename_index_in_path;
					basename_index_in_path = path->size();
					temp.clear();
					append_directional(temp, &dirsep, 1, 0);
					if (!(match_paths && frs == 0x00000005))
					{
						append_directional(temp, &me->names[j->name.offset()], j->name.length, j->name.ascii() ? -1 : 0);
					}
					this->operator()(frs, ji, temp.data(), temp.size());
					basename_index_in_path = old_basename_index_in_path;
				}
			}
		}

		void operator()(key_type::frs_type const frs, key_type::name_info_type const name_info, TCHAR const stream_prefix [], size_t const stream_prefix_size)
		{
			bool const match_paths_or_streams = match_paths || match_streams || match_attributes;
			bool const buffered_matching = stream_prefix_size || match_paths_or_streams;
			if (frs < me->records_lookup.size() && (frs == 0x00000005 || frs >= 0x00000010 || this->match_attributes))
			{
				Records::value_type const *const fr = me->find(frs);
				key_type new_key(frs, name_info, 0);
				ptrdiff_t traverse = 0;
				for (StreamInfos::value_type const *k = me->streaminfo(fr); k; k = me->streaminfo(k->next_entry), new_key.stream_info(new_key.stream_info() + 1))
				{
					assert(k->name.offset() <= me->names.size());
					bool const is_attribute = k->type_name_id && (k->type_name_id << (CHAR_BIT / 2)) != ntfs::AttributeData;
					if (!match_attributes && is_attribute) { continue; }
					size_t const old_size = path->size();
					if (stream_prefix_size)
					{
						path->append(stream_prefix, stream_prefix_size);
					}
					if (match_paths_or_streams)
					{
						if ((fr->stdinfo.attributes() & FILE_ATTRIBUTE_DIRECTORY) && frs != 0x00000005)
						{
							path->push_back(_T('\\'));
						}
					}
					if (match_streams || match_attributes)
					{
						if (k->name.length)
						{
							path->push_back(_T(':'));
							append_directional(*path, k->name.length ? &me->names[k->name.offset()] : NULL, k->name.length, k->name.ascii() ? -1 : 0);
						}
						if (is_attribute)
						{
							if (!k->name.length) { path->push_back(_T(':')); }
							path->push_back(_T(':')), path->append(ntfs::attribute_names[k->type_name_id].data, ntfs::attribute_names[k->type_name_id].size);
						}
					}
					bool ascii;
					size_t name_offset, name_length;
					if (buffered_matching)
					{
						name_offset = match_paths ? 0 : static_cast<unsigned int>(basename_index_in_path);
						name_length = path->size() - name_offset;
						ascii = false;
					}
					else
					{
						name_offset = name.offset();
						name_length = name.length;
						ascii = name.ascii();
					}
					if (frs != 0x00000005 || ((depth > 0) ^ (k->type_name_id == 0))) /* this is to list the root directory at the top level, but its attributes at level 1 */
					{
						traverse += func((buffered_matching ? path->data() : &*me->names.begin()) + static_cast<ptrdiff_t>(name_offset), name_length, ascii, new_key, depth);
					}
					if (buffered_matching)
					{
						path->erase(old_size, path->size() - old_size);
					}
				}
				if ((frs != 0x00000005 || depth == 0) && traverse > 0)
				{
					size_t const old_size = path->size();
					NameInfo const old_name = name;
					size_t const old_basename_index_in_path = basename_index_in_path;
					++depth;
					if (buffered_matching)
					{
						if (match_paths_or_streams) { path->push_back(_T('\\')); }
						basename_index_in_path = path->size();
					}
					unsigned short ii = 0;
					for (ChildInfos::value_type const *i = me->childinfo(fr); i && ~i->record_number; i = me->childinfo(i->next_entry), ++ii)
					{
						unsigned short name_index = i->name_index;
						unsigned int record_number = i->record_number;
					START:
#pragma warning(push)
#pragma warning(disable: 4456)
						if (bool i = true /* this is to HIDE the outer 'i', to prevent accessing it directly (because we put in a dummy entry sometimes) */)
#pragma warning(pop)
						{
							Records::value_type const *const fr2 = me->find(record_number);
							unsigned short const ji_target = fr2->name_count - static_cast<size_t>(1) - name_index;
							unsigned short ji = 0;
							for (LinkInfos::value_type const *j = me->nameinfo(fr2); j; j = me->nameinfo(j->next_entry), ++ji)
							{
								if (j->parent == frs && ji == ji_target)
								{
									if (buffered_matching)
									{
										append_directional(*path, &me->names[j->name.offset()], j->name.length, j->name.ascii() ? -1 : 0);
									}
									name = j->name;
									this->operator()(static_cast<key_type::frs_type>(record_number), ji, NULL, 0);
									if (buffered_matching)
									{
										path->erase(path->end() - static_cast<ptrdiff_t>(j->name.length), path->end());
									}
								}
							}
						}
						if (record_number == 0x00000006 && depth == 1)
						{
							name_index = 0;
							record_number = 0x00000005;
							goto START;
						}
					}
					--depth;
					basename_index_in_path = old_basename_index_in_path;
					name = old_name;
					if (buffered_matching)
					{
						path->erase(old_size, path->size() - old_size);
					}
				}
			}
		}
	};
};


struct MatchOperation
{
	value_initialized<bool>
		is_regex,
		is_path_pattern,
		is_stream_pattern,
		requires_root_path_match;
	std::tvstring root_path_optimized_away;
	string_matcher matcher;
	MatchOperation() { }
	void init(std::tstring pattern)
	{
		is_regex = !pattern.empty() && *pattern.begin() == _T('>');
		if (is_regex) { pattern.erase(pattern.begin()); }
		is_path_pattern = is_regex || ~pattern.find(_T('\\')) || ~pattern.find(_T("**"));
		is_stream_pattern = is_regex || ~pattern.find(_T(':'));
		requires_root_path_match = is_path_pattern && !is_regex && pattern.size() >= 2 && *(pattern.begin() + 0) != _T('*') && *(pattern.begin() + 0) != _T('?') && *(pattern.begin() + 1) != _T('*') && *(pattern.begin() + 1) != _T('?');
		if (requires_root_path_match)
		{
			root_path_optimized_away.insert(root_path_optimized_away.end(), pattern.begin(), std::find(pattern.begin(), pattern.end(), _T('\\')));
			pattern.erase(pattern.begin(), pattern.begin() + static_cast<ptrdiff_t>(root_path_optimized_away.size()));
		}
		if (!is_path_pattern && !~pattern.find(_T('*')) && !~pattern.find(_T('?'))) { pattern.insert(pattern.begin(), _T('*')); pattern.insert(pattern.begin(), _T('*')); pattern.insert(pattern.end(), _T('*')); pattern.insert(pattern.end(), _T('*')); }
		string_matcher(is_regex ? string_matcher::pattern_regex : is_path_pattern ? string_matcher::pattern_globstar : string_matcher::pattern_glob, string_matcher::pattern_option_case_insensitive, pattern.data(), pattern.size()).swap(matcher);
	}
	bool prematch(std::tvstring const &root_path) const
	{
		return !requires_root_path_match || (
			root_path.size() >= root_path_optimized_away.size() &&
			std::equal(root_path.begin(), root_path.begin() + static_cast<ptrdiff_t>(root_path_optimized_away.size()), root_path_optimized_away.begin())
		);
	}
	std::tvstring get_current_path(std::tvstring const &root_path) const
	{
		std::tvstring current_path = root_path_optimized_away.empty() ? root_path : std::tvstring();
		while (!current_path.empty() && *(current_path.end() - 1) == _T('\\')) { current_path.erase(current_path.end() - 1); }
		return current_path;
	}
};

namespace std
{
#ifdef _XMEMORY_
#define X(...) template<> struct is_scalar<__VA_ARGS__> : is_pod<__VA_ARGS__>{}
	X(NtfsIndex::StandardInfo);
	X(NtfsIndex::NameInfo);
	X(NtfsIndex::StreamInfo);
	X(NtfsIndex::LinkInfo);
	X(NtfsIndex::Record);
#undef X
#endif
}

class CoInit
{
	CoInit(CoInit const &);
	CoInit &operator =(CoInit const &);
public:
	HRESULT hr;
	CoInit(bool initialize = true) : hr(initialize ? CoInitialize(NULL) : S_FALSE) { }
	~CoInit() { if (this->hr == S_OK) { CoUninitialize(); } }
};

class OleInit
{
	OleInit(OleInit const &);
	OleInit &operator =(OleInit const &);
public:
	HRESULT hr;
	OleInit(bool initialize = true) : hr(initialize ? OleInitialize(NULL) : S_FALSE) { }
	~OleInit() { if (this->hr == S_OK) { OleUninitialize(); } }
};



template<class T>
class TempSwap
{
	TempSwap(TempSwap const &);
	TempSwap &operator =(TempSwap const &);
	T *target, old_value;
public:
	~TempSwap() { if (this->target) { using std::swap; swap(*this->target, this->old_value); } }
	TempSwap() : target(), old_value() { }
	explicit TempSwap(T &target, T const &new_value) : target(&target), old_value(new_value) { using std::swap; swap(*this->target, this->old_value); }
	void reset() { TempSwap().swap(*this); }
	void reset(T &target, T const &new_value) { TempSwap(target, new_value).swap(*this); }
	void swap(TempSwap &other) { using std::swap; swap(this->target, other.target); swap(this->old_value, other.old_value); }
};


class IoCompletionPort
{
	typedef IoCompletionPort this_type;
	IoCompletionPort(this_type const &);
	this_type &operator =(this_type const &);
protected:
	struct Task
	{
		HANDLE file;
		unsigned long issuing_thread_id;
		void *buffer;
		unsigned long cb;
		intrusive_ptr<Overlapped> overlapped;
		Task() : file(), buffer(), cb() { }
		explicit Task(void *const buffer, unsigned long const cb, intrusive_ptr<Overlapped> const &overlapped) : buffer(buffer), cb(cb), overlapped(overlapped) { }
	};
	struct WorkerThread
	{
		Handle handle;
		~WorkerThread()
		{
			WaitForSingleObject(this->handle, INFINITE);
		}
	};
	typedef std::vector<Task> Pending;
	static unsigned int CALLBACK iocp_worker(void *me)
	{
		return static_cast<this_type volatile *>(me)->worker();
	}
	static unsigned long get_num_threads()
	{
		unsigned long num_threads = 0;
#ifdef _OPENMP
#pragma omp parallel
#pragma omp atomic
		++num_threads;
#else
		TCHAR const *const omp_num_threads = _tgetenv(_T("OMP_NUM_THREADS"));
		if (int const n = omp_num_threads ? _ttoi(omp_num_threads) : 0)
		{
			num_threads = static_cast<int>(n);
		}
		else
		{
#ifdef _DEBUG
			num_threads = 1;
#else
			SYSTEM_INFO sysinfo;
			GetSystemInfo(&sysinfo);
			num_threads = sysinfo.dwNumberOfProcessors;
#endif
		}
#endif
		return num_threads;
	}
	virtual unsigned int worker() volatile
	{
		return this->worker(INFINITE);
	}
	virtual unsigned int worker(unsigned long const timeout) volatile
	{
		unsigned int result = 0;
		ULONG_PTR key;
		OVERLAPPED *overlapped_ptr;
		Overlapped *p;
		try
		{
			for (unsigned long nr; GetQueuedCompletionStatus(this->_handle, &nr, &key, &overlapped_ptr, timeout);)
			{
				p = static_cast<Overlapped *>(overlapped_ptr);
				intrusive_ptr<Overlapped> overlapped(p, false);
				if (overlapped.get())
				{
					int r = (*overlapped)(static_cast<size_t>(nr), key);
					if (r > 0) { r = this->try_post(nr, key, overlapped) ? 0 : -1; }
					if (r >= 0) { overlapped.detach(); }
				}
				else if (key == 1)
				{
					size_t found = ~size_t();
					Task task;
					{
						lock_ptr<this_type> const me_lock(this);
						size_t &pending_scan_offset = const_cast<size_t &>(this->_pending_scan_offset);
						Pending &pending = const_cast<Pending &>(this->_pending);
						winnt::IO_PRIORITY_HINT found_priority = winnt::MaxIoPriorityTypes;
						for (size_t o = 0; o != pending.size(); ++o)
						{
							if (pending_scan_offset == 0 || pending_scan_offset > pending.size()) { pending_scan_offset = pending.size(); }
							--pending_scan_offset;
							size_t const i = pending_scan_offset;
							winnt::IO_PRIORITY_HINT const curr_priority = IoPriority::query(reinterpret_cast<uintptr_t>(pending[i].file));
							if (found_priority == winnt::MaxIoPriorityTypes || curr_priority > found_priority)
							{
								found = i;
								found_priority = curr_priority;
							}
						}
						if (found < pending.size())
						{
							pending_scan_offset = found;
							task = pending[found];
							pending.erase(pending.begin() + static_cast<ptrdiff_t>(found));
						}
					}
					if (~found)
					{
						this->enqueue(task);
					}
				}
				else if (key == 0)
				{
					this->_terminated.store(true, atomic_namespace::memory_order_release);
					this->cancel_thread_ios();
					break;
				}
			}
		}
		catch (CStructured_Exception &ex)
		{
			result = ex.GetSENumber();
			if (result != ERROR_CANCELLED
#ifndef _DEBUG
				&& IsDebuggerPresent()
#endif
				)
			{
				throw;
			}
		}
		return result;
	}
	void enqueue(Task &task) volatile
	{
		bool attempted_reading_file = false;
		if (!task.cb || (!this->_terminated.load(atomic_namespace::memory_order_acquire) && ((attempted_reading_file = true), ReadFile(task.file, task.buffer, task.cb, NULL, task.overlapped.get()))))
		{
			this->post(task.cb, 0, task.overlapped);
		}
		else if (attempted_reading_file)
		{
			CheckAndThrow(GetLastError() == ERROR_IO_PENDING);
			task.overlapped.detach();
		}
	}
	void cancel_thread_ios() volatile  // Requests cancellation of all I/Os initiated by the current thread
	{
		lock_ptr<this_type> const me_lock(this);
		Pending &pending = const_cast<Pending &>(this->_pending);
		unsigned long const thread_id = GetCurrentThreadId();
		for (size_t i = 0; i != pending.size(); ++i)
		{
			if (pending[i].issuing_thread_id == thread_id)
			{
				CancelIo(pending[i].file);
			}
		}
	}
	Handle _handle;
	atomic_namespace::atomic<bool> _initialized, _terminated;
	std::vector<WorkerThread> _threads;
	mutable atomic_namespace::recursive_mutex _mutex;
	Pending _pending;
	size_t _pending_scan_offset;
public:
	~IoCompletionPort() { this->close(); }
	IoCompletionPort() : _handle(CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, NULL, 0)), _initialized(false), _terminated(false), _pending_scan_offset() { }
	this_type *unvolatile() volatile { return const_cast<this_type *>(this); }
	this_type const *unvolatile() const volatile { return const_cast<this_type *>(this); }
	atomic_namespace::recursive_mutex &get_mutex() const volatile { return this->unvolatile()->_mutex; }
	void ensure_initialized()
	{
		if (this->_threads.empty())
		{
			size_t const nthreads = static_cast<size_t>(get_num_threads());
			this->_threads.resize(nthreads);
			for (size_t i = nthreads; i != 0 && ((void)--i, true); )
			{
				unsigned int id;
				Handle(reinterpret_cast<HANDLE>(_beginthreadex(NULL, 0, iocp_worker, this, 0, &id))).swap(this->_threads.at(i).handle);
			}
			this->_initialized.store(true, atomic_namespace::memory_order_release);
		}
	}
	void ensure_initialized() volatile
	{
		if (!this->_initialized.load(atomic_namespace::memory_order_acquire))
		{
			lock(this)->ensure_initialized();
		}
	}
	void post(unsigned long cb, uintptr_t const key, intrusive_ptr<Overlapped> overlapped) volatile
	{
		CheckAndThrow(this->try_post(cb, key, overlapped));
		overlapped.detach();
	}
	bool try_post(unsigned long cb, uintptr_t const key, intrusive_ptr<Overlapped> &overlapped) volatile
	{
		this->ensure_initialized();
		if (!(cb == 0 && key == 0 && !overlapped) && this->_terminated.load(atomic_namespace::memory_order_acquire))
		{
			CppRaiseException(ERROR_CANCELLED);
		}
		return !!PostQueuedCompletionStatus(this->_handle, cb, key, overlapped.get());
	}
	void read_file(HANDLE const file, void *const buffer, unsigned long const cb, intrusive_ptr<Overlapped> const &overlapped) volatile
	{
		// This part needs a lock
		{
			lock_ptr<this_type> const me_lock(this);
			Pending &pending = const_cast<Pending &>(this->_pending);
			pending.push_back(Task());
			Task &task = pending.back();
			task.file = file;
			task.issuing_thread_id = GetCurrentThreadId();
			task.buffer = buffer;
			task.cb = cb;
			task.overlapped = overlapped;
		}
		this->post(0, 1, NULL);
	}
	void associate(HANDLE const file, uintptr_t const key) volatile
	{
		this->ensure_initialized();
		CheckAndThrow(!!CreateIoCompletionPort(file, this->_handle, key, 0));
	}
	void close()
	{
		for (size_t i = 0; i != this->_threads.size(); ++i)
		{ this->post(0, 0, NULL); }
		this->cancel_thread_ios();
		this->_threads.clear();  // Destructors ensure all threads terminate
		this->worker(0 /* dequeue all packets */);
	}
};

class OleIoCompletionPort : public IoCompletionPort
{
	virtual unsigned int worker() volatile override
	{
		unsigned int result = 0;
		result = this->IoCompletionPort::worker();
		return result;
	}

	virtual unsigned int worker(unsigned long const timeout) volatile override
	{
		CoInit coinit;
		return this->IoCompletionPort::worker(timeout);
	}
};

class OverlappedNtfsMftReadPayload : public Overlapped
{
protected:
	struct RetPtr
	{
		unsigned long long vcn, cluster_count;
		long long lcn;
		atomic_namespace::atomic<unsigned long long> skip_begin, skip_end;
		RetPtr(unsigned long long const vcn, unsigned long long const cluster_count, unsigned long long const lcn) : vcn(vcn), cluster_count(cluster_count), lcn(lcn), skip_begin(0), skip_end(0) { }
		RetPtr(RetPtr const &other) : vcn(other.vcn), cluster_count(other.cluster_count), lcn(other.lcn), skip_begin(other.skip_begin.load(atomic_namespace::memory_order_relaxed)), skip_end(other.skip_end.load(atomic_namespace::memory_order_relaxed)) { }
		RetPtr &operator =(RetPtr const &other)
		{
			this->vcn = other.vcn;
			this->cluster_count = other.cluster_count;
			this->lcn = other.lcn;
			this->skip_begin.store(other.skip_begin.load(atomic_namespace::memory_order_relaxed));
			this->skip_end.store(other.skip_end.load(atomic_namespace::memory_order_relaxed));
			return *this;
		}
	};
	typedef std::vector<RetPtr> RetPtrs;
	typedef std::vector<unsigned char> Bitmap;
	IoCompletionPort volatile *iocp;
	Handle closing_event;
	RetPtrs bitmap_ret_ptrs, data_ret_ptrs;
	unsigned int cluster_size;
	unsigned long long read_block_size;
	atomic_namespace::atomic<RetPtrs::size_type> jbitmap, nbitmap_chunks_left, jdata;
	atomic_namespace::atomic<unsigned int> valid_records;
	Bitmap mft_bitmap;  // may be unavailable -- don't fail in that case!
	intrusive_ptr<NtfsIndex volatile> p;
public:
	class ReadOperation;
	~OverlappedNtfsMftReadPayload()
	{
	}
	OverlappedNtfsMftReadPayload(IoCompletionPort volatile &iocp, intrusive_ptr<NtfsIndex volatile> p, Handle const &closing_event)
		: Overlapped(), iocp(&iocp), closing_event(closing_event), cluster_size(), read_block_size(1 << 20), jbitmap(0), nbitmap_chunks_left(0), jdata(0), valid_records(0)
	{
		using std::swap; swap(p, this->p);
	}
	void queue_next() volatile;
	int operator()(size_t const /*size*/, uintptr_t const /*key*/);
	virtual void preopen() { }
};
class OverlappedNtfsMftReadPayload::ReadOperation : public Overlapped
{
	unsigned long long _voffset, _skipped_begin, _skipped_end;
	clock_t _time;
	static atomic_namespace::recursive_mutex recycled_mutex;
	static std::vector<std::pair<size_t, void *> > recycled;
	bool _is_bitmap;
	intrusive_ptr<OverlappedNtfsMftReadPayload volatile> q;
	static void *operator new(size_t n)
	{
		void *p;
		if (true)
		{
			{
				atomic_namespace::unique_lock<atomic_namespace::recursive_mutex> guard(recycled_mutex);
				size_t ifound = recycled.size();
				for (size_t i = 0; i != recycled.size(); ++i)
				{
					if (recycled[i].first >= n && (ifound >= recycled.size() || recycled[i].first <= recycled[ifound].first))
					{
						ifound = i;
					}
				}
				if (ifound < recycled.size())
				{
					p = recycled[ifound].second;
					recycled.erase(recycled.begin() + static_cast<ptrdiff_t>(ifound));
				}
				else
				{
					p = NULL;
				}
			}
			if (!p)
			{
				p = malloc(n) /* so we can use _msize() */;
			}
		}
		else { p = ::operator new(n); }
		return p;
	}
public:
	static void *operator new(size_t n, size_t m) { return operator new(n + m); }
	static void operator delete(void *p)
	{
		if (true)
		{
			atomic_namespace::unique_lock<atomic_namespace::recursive_mutex>(recycled_mutex), recycled.push_back(std::pair<size_t, void *>(_msize(p), p));
		}
		else
		{
			return ::operator delete(p);
		}
	}
	static void operator delete(void *p, size_t /*m*/) { return operator delete(p); }
	explicit ReadOperation(intrusive_ptr<OverlappedNtfsMftReadPayload volatile> const &q, bool const is_bitmap)
		: Overlapped(), _voffset(), _skipped_begin(), _skipped_end(), _time(clock()), _is_bitmap(is_bitmap), q(q) { }
	unsigned long long voffset() { return this->_voffset; }
	void voffset(unsigned long long const value) { this->_voffset = value; }
	unsigned long long skipped_begin() { return this->_skipped_begin; }
	void skipped_begin(unsigned long long const value) { this->_skipped_begin = value; }
	unsigned long long skipped_end() { return this->_skipped_end; }
	void skipped_end(unsigned long long const value) { this->_skipped_end = value; }
	clock_t time() { return this->_time; }
	void time(clock_t const value) { this->_time = value; }
	int operator()(size_t const size, uintptr_t const /*key*/)
	{
		OverlappedNtfsMftReadPayload *const q = const_cast<OverlappedNtfsMftReadPayload *>(static_cast<OverlappedNtfsMftReadPayload volatile *>(this->q.get()));
		if (!q->p->cancelled())
		{
			this->q->queue_next();
			void *const buffer = this + 1;
			if (this->_is_bitmap)
			{
				size_t const records_per_bitmap_word = sizeof(*q->mft_bitmap.begin()) * CHAR_BIT;
				if (this->voffset() * CHAR_BIT <= q->p->mft_capacity)
				{
					static unsigned char const popcount [] = { 0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4 };
					unsigned int nrecords = 0;
					size_t n = size;
					if (this->voffset() + n >= q->p->mft_capacity / CHAR_BIT)
					{
						n = static_cast<size_t>(q->p->mft_capacity / CHAR_BIT - this->voffset());
					}
					for (size_t i = 0; i < n; ++i)
					{
						unsigned char const
							v = static_cast<unsigned char const *>(buffer)[i],
							vlow = static_cast<unsigned char>(v >> (CHAR_BIT / 2)),
							vhigh = static_cast<unsigned char>(v ^ (vlow << (CHAR_BIT / 2)));
						nrecords += popcount[vlow];
						nrecords += popcount[vhigh];
					}
					std::copy(static_cast<unsigned char const *>(buffer), static_cast<unsigned char const *>(buffer) + static_cast<ptrdiff_t>(n), q->mft_bitmap.begin() + static_cast<ptrdiff_t>(this->voffset()));
					q->valid_records.fetch_add(nrecords, atomic_namespace::memory_order_acq_rel);
				}
				if (q->nbitmap_chunks_left.fetch_sub(1, atomic_namespace::memory_order_acq_rel) == 1)
				{
					unsigned int const valid_records = q->valid_records.exchange(0 /* make sure this doesn't happen twice */, atomic_namespace::memory_order_acq_rel);
					lock(q->p)->reserve(valid_records);

					// Now, go remove records from the queue that we know are invalid...
					for (RetPtrs::iterator i = q->data_ret_ptrs.begin(); i != q->data_ret_ptrs.end(); ++i)
					{
						size_t const
							irecord = static_cast<size_t>(i->vcn * q->cluster_size / q->p->mft_record_size),
							nrecords = static_cast<size_t>(i->cluster_count * q->cluster_size / q->p->mft_record_size);
						size_t skip_records_begin, skip_records_end;
						// TODO: We're doing a bitmap search bit-by-bit here, which is slow...
						// maybe improve it at some point... but OTOH it's still much faster than I/O anyway, so whatever...
						for (skip_records_begin = 0; skip_records_begin != nrecords; ++skip_records_begin)
						{
							size_t const j = irecord + skip_records_begin, j1 = j / records_per_bitmap_word, j2 = j % records_per_bitmap_word;
							if (q->mft_bitmap[j1] & (1 << j2)) { break; }
						}
						for (skip_records_end = 0; skip_records_end != nrecords - skip_records_begin; ++skip_records_end)
						{
							size_t const j = irecord + nrecords - 1 - skip_records_end, j1 = j / records_per_bitmap_word, j2 = j % records_per_bitmap_word;
							if (q->mft_bitmap[j1] & (1 << j2)) { break; }
						}
						size_t
							skip_clusters_begin = static_cast<size_t>(static_cast<unsigned long long>(skip_records_begin) * q->p->mft_record_size / q->cluster_size),
							skip_clusters_end = static_cast<size_t>(static_cast<unsigned long long>(skip_records_end) * q->p->mft_record_size / q->cluster_size);
						if (skip_clusters_begin + skip_clusters_end > i->cluster_count) { throw std::logic_error("we should never be skipping more clusters than there are"); }
						i->skip_begin.store(skip_clusters_begin, atomic_namespace::memory_order_release);
						i->skip_end.store(skip_clusters_end, atomic_namespace::memory_order_release);
					}
				}
			}
			else
			{
				unsigned long long const virtual_offset = this->voffset();
				q->p->preload_concurrent(virtual_offset, buffer, size);
				lock(q->p)->load(virtual_offset, buffer, size, this->skipped_begin(), this->skipped_end());
			}
			{
				lock(q->p)->report_speed(size, this->time(), clock());
			}
		}
		return -1;
	}
};
atomic_namespace::recursive_mutex OverlappedNtfsMftReadPayload::ReadOperation::recycled_mutex;
std::vector<std::pair<size_t, void *> > OverlappedNtfsMftReadPayload::ReadOperation::recycled;

void OverlappedNtfsMftReadPayload::queue_next() volatile
{
	OverlappedNtfsMftReadPayload const *const me = const_cast<OverlappedNtfsMftReadPayload const *>(this);
	bool handled = false;
	if (!handled)
	{
		size_t const jbitmap = this->jbitmap.fetch_add(1, atomic_namespace::memory_order_acq_rel);
		if (jbitmap < me->bitmap_ret_ptrs.size())
		{
			handled = true;
			RetPtrs::const_iterator const j = me->bitmap_ret_ptrs.begin() + static_cast<ptrdiff_t>(jbitmap);
			unsigned long long const
				skip_begin = j->skip_begin.load(atomic_namespace::memory_order_acquire),
				skip_end = j->skip_end.load(atomic_namespace::memory_order_acquire);
			unsigned int const cb = static_cast<unsigned int>((j->cluster_count - (skip_begin + skip_end)) * me->cluster_size);
			intrusive_ptr<ReadOperation> p(new(cb) ReadOperation(this, true));
			p-> offset((j->lcn + skip_begin) * static_cast<long long>(me->cluster_size));
			p->voffset((j->vcn + skip_begin) * me->cluster_size);
			p->skipped_begin(skip_begin * me->cluster_size);
			p->skipped_end(skip_end * me->cluster_size);
			p->time(clock());
			me->iocp->read_file(me->p->volume(), p.get() + 1, cb, p);
		}
		else if (jbitmap > me->bitmap_ret_ptrs.size())
		{
			// oops, increased multiple times... decrease to keep at max
			this->jbitmap.fetch_sub(1, atomic_namespace::memory_order_acq_rel);
		}
	}
	if (!handled)
	{
		size_t const jdata = this->jdata.fetch_add(1, atomic_namespace::memory_order_acq_rel);
		if (jdata < me->data_ret_ptrs.size())
		{
			handled = true;
			RetPtrs::const_iterator const j = me->data_ret_ptrs.begin() + static_cast<ptrdiff_t>(jdata);
			unsigned long long const
				skip_begin = j->skip_begin.load(atomic_namespace::memory_order_acquire),
				skip_end = j->skip_end.load(atomic_namespace::memory_order_acquire);
			unsigned int const cb = static_cast<unsigned int>((j->cluster_count - (skip_begin + skip_end)) * me->cluster_size);
			intrusive_ptr<ReadOperation> p(new(cb) ReadOperation(this, false));
			p-> offset((j->lcn + skip_begin) * static_cast<long long>(me->cluster_size));
			p->voffset((j->vcn + skip_begin) * me->cluster_size);
			p->skipped_begin(skip_begin * me->cluster_size);
			p->skipped_end(skip_end * me->cluster_size);
			p->time(clock());
			me->iocp->read_file(me->p->volume(), p.get() + 1, cb, p);
		}
		else if (jdata > me->data_ret_ptrs.size())
		{
			// oops, increased multiple times... decrease to keep at max
			this->jdata.fetch_sub(1, atomic_namespace::memory_order_acq_rel);
		}
	}
}
int OverlappedNtfsMftReadPayload::operator()(size_t const /*size*/, uintptr_t const key)
{
	int result = -1;
	intrusive_ptr<NtfsIndex> p = this->p->unvolatile();
	struct SetFinished
	{
		intrusive_ptr<NtfsIndex> p;
		unsigned int result;
		~SetFinished() { if (p) { p->set_finished(this->result); } }
	} set_finished = { p };
	try
	{
		if (!p->init_called())
		{
			p->init();
		}
		if (void *const volume = p->volume())
		{
			this->preopen();
			unsigned long br;
			NTFS_VOLUME_DATA_BUFFER info;
			CheckAndThrow(DeviceIoControl(volume, FSCTL_GET_NTFS_VOLUME_DATA, NULL, 0, &info, sizeof(info), &br, NULL));
			this->cluster_size = static_cast<unsigned int>(info.BytesPerCluster);
			p->cluster_size = info.BytesPerCluster;
			p->mft_record_size = info.BytesPerFileRecordSegment;
			p->mft_capacity = static_cast<unsigned int>(info.MftValidDataLength.QuadPart / info.BytesPerFileRecordSegment);
			p->mft_zone_start = info.MftZoneStart.QuadPart;
			p->mft_zone_end = info.MftZoneEnd.QuadPart;
			p->mft_zone_end = p->mft_zone_start;  // This line suppresses MFT zone inclusion in the "size on disk"
			p->reserved_clusters.store(info.TotalReserved.QuadPart + p->mft_zone_end - p->mft_zone_start);
			this->iocp->associate(volume, reinterpret_cast<uintptr_t>(&*p));
			typedef std::vector<std::pair<unsigned long long, long long> > RP;
			{
				{
					long long llsize = 0;
					RP const ret_ptrs = get_retrieval_pointers((p->root_path() + std::tvstring(_T("$MFT::$BITMAP"))).c_str(), &llsize, info.MftStartLcn.QuadPart, this->p->mft_record_size);
					unsigned long long prev_vcn = 0;
					for (RP::const_iterator i = ret_ptrs.begin(); i != ret_ptrs.end(); ++i)
					{
						long long const clusters_left = static_cast<long long>(std::max(i->first, prev_vcn) - prev_vcn);
						unsigned long long n;
						for (long long m = 0; m < clusters_left; m += static_cast<long long>(n))
						{
							n = std::min(i->first - prev_vcn, 1 + (static_cast<unsigned long long>(this->read_block_size) - 1) / this->cluster_size);
							this->bitmap_ret_ptrs.push_back(RetPtrs::value_type(prev_vcn, n, i->second + m));
							prev_vcn += n;
						}
					}
					this->mft_bitmap.resize(static_cast<size_t>(llsize), static_cast<Bitmap::value_type>(~Bitmap::value_type()) /* default should be to read unused slots too */);
					this->nbitmap_chunks_left.store(this->bitmap_ret_ptrs.size(), atomic_namespace::memory_order_release);
				}
				{
					long long llsize = 0;
					RP const ret_ptrs = get_retrieval_pointers((p->root_path() + std::tvstring(_T("$MFT::$DATA"))).c_str(), &llsize, info.MftStartLcn.QuadPart, p->mft_record_size);
					if (ret_ptrs.empty()) { CppRaiseException(ERROR_UNRECOGNIZED_VOLUME); }
					unsigned long long prev_vcn = 0;
					for (RP::const_iterator i = ret_ptrs.begin(); i != ret_ptrs.end(); ++i)
					{
						long long const clusters_left = static_cast<long long>(std::max(i->first, prev_vcn) - prev_vcn);
						unsigned long long n;
						for (long long m = 0; m < clusters_left; m += static_cast<long long>(n))
						{
							n = std::min(i->first - prev_vcn, 1 + (static_cast<unsigned long long>(this->read_block_size) - 1) / this->cluster_size);
							this->data_ret_ptrs.push_back(RetPtrs::value_type(prev_vcn, n, i->second + m));
							prev_vcn += n;
						}
					}
				}
			}
			{
				set_finished.p.reset();  // make sure we don't set this as finished anymore
				for (int concurrency = 0; concurrency < 2; ++concurrency)
				{
					this->queue_next();
				}
			}
		}
	}
	catch (CStructured_Exception &ex)
	{
		set_finished.result = ex.GetSENumber();
	}
	return result;
}

std::vector<std::tvstring> get_volume_path_names()
{
	typedef std::tvstring String;
	std::vector<String> result;
	String buf;
	size_t prev;
	do
	{
		prev = buf.size();
		buf.resize(std::max(static_cast<size_t>(GetLogicalDriveStrings(static_cast<unsigned long>(buf.size()), buf.empty() ? NULL : &*buf.begin())), buf.size()));
	} while (prev < buf.size());
	for (size_t i = 0, n; n = std::char_traits<TCHAR>::length(&buf[i]), i < buf.size() && buf[i]; i += n + 1)
	{
		result.push_back(String(&buf[i], n));
	}
	return result;
}

#pragma pack(push, 1)
struct SearchResult
{
	typedef unsigned short index_type;
	typedef unsigned short depth_type;
	explicit SearchResult(NtfsIndex::key_type const key, depth_type const depth)
		: _key(key), _depth(depth) { }
	NtfsIndex::key_type key() const { return this->_key; }
	depth_type depth() const { return static_cast<depth_type>(this->_depth); }
	NtfsIndex::key_type::index_type index() const { return this->_key.index(); }
	void index(NtfsIndex::key_type::index_type const value) { this->_key.index(value); }
private:
	NtfsIndex::key_type _key;
	depth_type _depth;
};
#pragma pack(pop)

#ifdef _MSC_VER
__declspec(align(0x40))
#endif
class Results : memheap_vector<SearchResult>
{
	typedef Results this_type;
	typedef memheap_vector<value_type, allocator_type> base_type;
	typedef std::vector<intrusive_ptr<NtfsIndex volatile const> > Indexes;
	typedef std::vector<std::pair<Indexes::value_type::value_type *, SearchResult::index_type> > IndicesInUse;
	Indexes indexes /* to keep alive */;
	IndicesInUse indices_in_use /* to keep alive */;
public:
	typedef base_type::allocator_type allocator_type;
	typedef base_type::value_type value_type;
	typedef base_type::reverse_iterator iterator;
	typedef base_type::const_reverse_iterator const_iterator;
	typedef base_type::size_type size_type;
	Results() : base_type() { }
	explicit Results(allocator_type const &alloc) : base_type(alloc) { }
	iterator begin() { return this->base_type::rbegin(); }
	const_iterator begin() const { return this->base_type::rbegin(); }
	iterator end() { return this->base_type::rend(); }
	const_iterator end() const { return this->base_type::rend(); }
	using base_type::capacity;
	size_type size() const { return this->end() - this->begin(); }
	SearchResult::index_type save_index(Indexes::value_type::element_type *const index)
	{
		IndicesInUse::iterator j = std::lower_bound(this->indices_in_use.begin(), this->indices_in_use.end(), std::make_pair(index, IndicesInUse::value_type::second_type()));
		if (j == this->indices_in_use.end() || j->first != index)
		{
			this->indexes.push_back(index);
			j = this->indices_in_use.insert(j, IndicesInUse::value_type(index, static_cast<IndicesInUse::value_type::second_type>(this->indexes.size() - 1)));
		}
		return j->second;
	}
	Indexes::value_type::element_type *item_index(size_t const i) const { return this->ith_index((*this)[i].index()); }
	Indexes::value_type::element_type *ith_index(value_type::index_type const i) const { return this->indexes[i]; }
	value_type const &operator[](size_t const i) const { return this->begin()[static_cast<ptrdiff_t>(i)]; }
	void reserve(size_t const n)
	{
		(void) n;
		this->base_type::reserve(n);
	}
	void push_back(Indexes::value_type::element_type *const index, base_type::const_reference value)
	{
		this->base_type::push_back(value);
		(*(this->base_type::end() - 1)).index(this->save_index(index));
	}
	void clear()
	{
		this->base_type::clear();
		this->indexes.clear();
		this->indices_in_use.clear();
	}
	void swap(this_type &other)
	{
		this->base_type::swap(static_cast<base_type &>(other));
		this->indexes.swap(other.indexes);
		this->indices_in_use.swap(other.indices_in_use);
	}
	friend void swap(this_type &a, this_type &b) { return a.swap(b); }
};

long long get_time_zone_bias()
{
	long long ft = 0; GetSystemTimeAsFileTime(&reinterpret_cast<FILETIME &>(ft));
	long long ft_local; if (!FileTimeToLocalFileTime(&reinterpret_cast<FILETIME &>(ft), &reinterpret_cast<FILETIME &>(ft_local))) { ft_local = 0; }
	return ft_local - ft;
}

template<class Container> struct NFormatBase { typedef basic_iterator_ios<std::back_insert_iterator<Container>, typename Container::traits_type> type; };
class NFormat : public NFormatBase<std::tstring>::type, public NFormatBase<std::tvstring>::type
{
	typedef NFormat this_type;
public:
	explicit NFormat(std::locale const &loc) : NFormatBase<std::tstring>::type(loc), NFormatBase<std::tvstring>::type(loc) { }

	template<class T>
	struct lazy
	{
		this_type const *me;
		T const *value;
		explicit lazy(this_type const *const me, T const &value) : me(me), value(&value) { }
		operator std::tstring() const
		{
			std::tstring result;
			me->NFormatBase<std::tstring>::type::put(std::back_inserter(result), *value);
			return result;
		}
		operator std::tvstring() const
		{
			std::tvstring result;
			me->NFormatBase<std::tvstring>::type::put(std::back_inserter(result), *value);
			return result;
		}
		template<class String>
		friend String &operator+=(String &out, lazy const &this_)
		{
			this_.me->NFormatBase<String>::type::put(std::back_inserter(out), *this_.value);
			return out;
		}
	};
	template<class T>
	lazy<T> operator()(T const &value) const { return lazy<T>(this, value); }
};

extern "C" IMAGE_DOS_HEADER __ImageBase;

unsigned short get_subsystem(IMAGE_DOS_HEADER const *const image_base)
{
	return reinterpret_cast<IMAGE_NT_HEADERS const *>(reinterpret_cast<unsigned char const *>(image_base) + image_base->e_lfanew)->OptionalHeader.Subsystem;
}

unsigned long long get_version(IMAGE_DOS_HEADER const *const image_base)
{
	return reinterpret_cast<IMAGE_NT_HEADERS const *>(reinterpret_cast<unsigned char const *>(image_base) + image_base->e_lfanew)->FileHeader.TimeDateStamp * 10000000ULL + 0x019db1ded53e8000ULL;
}



	template<class StrCmp>
	class NameComparator
	{
		StrCmp less;
	public:
		NameComparator(StrCmp const &less) : less(less) { }
		bool operator()(Results::value_type const &a, Results::value_type const &b)
		{
			bool less = this->less(a.file_name(), b.file_name());
			if (!less && !this->less(b.file_name(), a.file_name()))
			{ less = this->less(a.stream_name(), b.stream_name()); }
			return less;
		}
		bool operator()(Results::value_type const &a, Results::value_type const &b) const
		{
			bool less = this->less(a.file_name(), b.file_name());
			if (!less && !this->less(b.file_name(), a.file_name()))
			{ less = this->less(a.stream_name(), b.stream_name()); }
			return less;
		}
	};

	template<class StrCmp>
	static NameComparator<StrCmp> name_comparator(StrCmp const &cmp) { return NameComparator<StrCmp>(cmp); }

	struct ResultCompareBase
	{
		~ResultCompareBase()
		{
		}
		struct swapper_type
		{
			ResultCompareBase *me;
			swapper_type(ResultCompareBase *const me) : me(me) { }
			void operator()(SearchResult &a, SearchResult &b)
			{
				SearchResult *const real_b = &a == &b ? NULL : &b;
				if (real_b)
				{
					using std::swap; swap(a, b);
				}
			}
		};
#pragma pack(push, 1)
		struct result_type
		{
			typedef unsigned short first_type;
			typedef unsigned long long second_type;
			first_type first;
			second_type second;
			result_type() : first(), second() { }
			result_type(first_type const &first, second_type const &second) : first(first), second(second) { }
			bool operator< (result_type const &other) const { return this->first < other.first || (!(other.first < this->first) && this->second < other.second); }
		};
#pragma pack(pop)
		typedef NtfsIndex Index;

		std::vector<Index::ParentIterator::value_type> *temp;
		std::vector<unsigned long long> *temp_keys;
		unsigned char variation;
		unsigned long long denominator;
		unsigned long long numerator;
		std::tvstring buffer, buffer2;
		swapper_type swapper() { return this; };
	};


int _tmain(int argc, TCHAR *argv[])
{
	int result;
	if (argc <= 1)
	{
		_ftprintf(stderr, _T("No arguments specified.\n"));
		result = 0;
	}
	else if (argc > 1)
	{
		int const
			stderr_fd = _fileno(stderr),
			stdout_fd = _fileno(stdout);
		(void)stderr_fd;
		(void)stdout_fd;
		result = 0;
		try
		{
			time_t const tbegin = clock();
			long long const time_zone_bias = get_time_zone_bias();
			LCID const lcid = GetThreadLocale();
			NFormat nformat_io((std::locale()));
			NFormat const &nformat = nformat_io;
			MatchOperation matchop;
			matchop.init(argv[1]);
			IoCompletionPort iocp;
			std::vector<intrusive_ptr<NtfsIndex> > indices;
			{
				std::vector<std::tvstring> path_names;
				if (argc > 2 && _tcscmp(argv[2], _T("*")) != 0)
				{
					std::tvstring arg(argv[2]);
					for (size_t i = 0; ; ++i)
					{
						size_t const j = arg.find(_T('|'), i);
						std::tvstring path_name(arg.data() + static_cast<ptrdiff_t>(i), (~j ? j : arg.size()) - i);
						adddirsep(path_name);
						path_names.push_back(path_name);
						if (!~j) { break; }
						i = j;
					}
				}
				else
				{
					get_volume_path_names().swap(path_names);
				}
				for (size_t i = 0; i != path_names.size(); ++i)
				{
					if (matchop.prematch(path_names[i]))
					{
						indices.push_back(static_cast<intrusive_ptr<NtfsIndex>>(new NtfsIndex(path_names[i])));
					}
				}
			}
			bool output_everything;
			if (argc > 3)
			{
				if (_tcsicmp(argv[3], _T("")) == 0)
				{
					output_everything = false;
				}
				else if (_tcscmp(argv[3], _T("*")) == 0)
				{
					output_everything = true;
				}
				else
				{
					throw std::invalid_argument("invalid column list; currently only \"\" (default) and \"*\" (all columns) are supported.");
				}
			}
			else { output_everything = false; }
			bool const match_attributes = false;
			std::vector<IoPriority> set_priorities(indices.size());
			Handle closing_event;
			std::vector<size_t> pending;
			for (size_t i = 0; i != indices.size(); ++i)
			{
				if (void *const volume = indices[i]->volume())
				{
					IoPriority(reinterpret_cast<uintptr_t>(volume), winnt::IoPriorityLow).swap(set_priorities[i]);
				}
				typedef OverlappedNtfsMftReadPayload T;
				intrusive_ptr<T> p(new T(iocp, indices[i], closing_event));
				iocp.post(0, static_cast<uintptr_t>(i), p);
				pending.push_back(i);
			}
			while (!pending.empty())
			{
				HANDLE wait_handles[MAXIMUM_WAIT_OBJECTS];
				unsigned int nwait_handles = 0;
				intrusive_ptr<NtfsIndex> i;
				{
					IoPriority const raise_first_priority(*pending.begin(), set_priorities[*pending.begin()].old());
					for (nwait_handles = 0; nwait_handles != pending.size() && nwait_handles != sizeof(wait_handles) / sizeof(*wait_handles); ++nwait_handles)
					{
						wait_handles[nwait_handles] = reinterpret_cast<HANDLE>(indices[pending[nwait_handles]]->finished_event());
					}
					DWORD const wait_result = WaitForMultipleObjects(nwait_handles, wait_handles, FALSE, INFINITE);
					if (wait_result < WAIT_OBJECT_0 + nwait_handles)
					{
						i = indices[pending[wait_result - WAIT_OBJECT_0]];
						pending.erase(pending.begin() + static_cast<ptrdiff_t>(wait_result - WAIT_OBJECT_0));
					}
				}
				if (i)
				{
					std::tvstring const root_path = i->root_path();
					std::tvstring current_path = matchop.get_current_path(root_path);
					class Writer
					{
						HANDLE output;
						bool output_isatty;
						bool output_isdevnull;
						size_t max_buffer_size;
						unsigned long long second_fraction_denominator /* NOTE: Too large a value is useless with clock(); use a more precise timer if needed */;
						clock_t tprev;
						unsigned long long nwritten_since_update;
						std::string line_buffer_utf8;
					public:
						explicit Writer(int const output, size_t const max_buffer_size = 0)
							: output(reinterpret_cast<HANDLE>(_get_osfhandle(output))), output_isatty(!!isatty(output)), output_isdevnull(isdevnull(output)), max_buffer_size(max_buffer_size), second_fraction_denominator(1 << 11), tprev(clock()), nwritten_since_update() { }
						void operator()(std::tvstring &line_buffer, bool const force = false)
						{
							if (!output_isdevnull)
							{
								clock_t const tnow = clock();
								unsigned long nwritten;
								if (force || line_buffer.size() >= max_buffer_size || (tnow - tprev) * 1000 * second_fraction_denominator >= CLOCKS_PER_SEC)
								{
									if ((!output_isatty || (!WriteConsole(output, line_buffer.data(), static_cast<unsigned int>(line_buffer.size()), &nwritten, NULL) && GetLastError() == ERROR_INVALID_HANDLE)))
									{
#if defined(_UNICODE) &&_UNICODE
										using std::max;
										line_buffer_utf8.resize(max(line_buffer_utf8.size(), (line_buffer.size() + 1) * 6), _T('\0'));
										int const cch = WideCharToMultiByte(CP_UTF8, 0, line_buffer.empty() ? NULL : &line_buffer[0], static_cast<int>(line_buffer.size()), &line_buffer_utf8[0], static_cast<int>(line_buffer_utf8.size()), NULL, NULL);
										if (cch > 0)
										{
											nwritten_since_update += WriteFile(output, line_buffer_utf8.data(), sizeof(*line_buffer_utf8.data()) * static_cast<size_t>(cch), &nwritten, NULL);
										}
#else
										nwritten_since_update += WriteFile(output, line_buffer.data(), sizeof(*line_buffer.data()) * line_buffer.size(), &nwritten, NULL);
#endif
									}
									line_buffer.clear();
									tprev = clock();
								}
							}
							else
							{
								line_buffer.clear();
							}
						}
					} flush_if_needed(stdout_fd, 1 << 15);
					std::tvstring line_buffer;
					i->matches([&](TCHAR const *const name, size_t const name_length, bool const ascii, NtfsIndex::key_type const &key, size_t const depth)
					/* TODO: Factor out common code from here and GUI-based version! */
					{
						size_t high_water_mark = 0, *phigh_water_mark = matchop.is_path_pattern ? &high_water_mark : NULL;
						TCHAR const *const path_begin = name;
						bool const match = ascii
							? matchop.matcher.is_match(static_cast<char const *>(static_cast<void const *>(path_begin)), name_length, phigh_water_mark)
							: matchop.matcher.is_match(path_begin, name_length, phigh_water_mark);
						if (match)
						{
							line_buffer += root_path;
							i->get_path(key, line_buffer, false);
							if (output_everything)
							{
								NtfsIndex::size_info const &sizeinfo = i->get_sizes(key);
								line_buffer.push_back(_T('\t')); line_buffer += nformat(sizeinfo.length);
								line_buffer.push_back(_T('\t')); line_buffer += nformat(sizeinfo.allocated);
								NtfsIndex::standard_info const &stdinfo = i->get_stdinfo(key.frs());
								/*  File attribute abbreviations: https://en.wikipedia.org/wiki/File_attribute#Types */
								line_buffer.push_back(_T('\t')); CMainDlg::SystemTimeToStringImpl(stdinfo.created, line_buffer, true, true, time_zone_bias, lcid);
								line_buffer.push_back(_T('\t')); CMainDlg::SystemTimeToStringImpl(stdinfo.written, line_buffer, true, true, time_zone_bias, lcid);
								line_buffer.push_back(_T('\t')); CMainDlg::SystemTimeToStringImpl(stdinfo.accessed, line_buffer, true, true, time_zone_bias, lcid);
								line_buffer.push_back(_T('\t')); line_buffer += nformat(static_cast<unsigned int>(sizeinfo.treesize));
							}
							line_buffer.push_back(_T('\n'));
							flush_if_needed(line_buffer);
						}
						return match || !(matchop.is_path_pattern && phigh_water_mark && *phigh_water_mark < name_length);
					}, current_path, matchop.is_path_pattern, matchop.is_stream_pattern, match_attributes);
					flush_if_needed(line_buffer, true);
				}
			}
			time_t const tend = clock();
			_ftprintf(stderr, _T("Finished in %u ms\n"), static_cast<unsigned int>((tend - tbegin) * 1000 / CLOCKS_PER_SEC));
		}
		catch (std::invalid_argument &ex)
		{
			fprintf(stderr, "%s\n", ex.what());
			result = ERROR_BAD_PATHNAME;
		}
		catch (CStructured_Exception &ex)
		{
			result = ex.GetSENumber();
			_ftprintf(stderr, _T("Error: %s\n"), GetAnyErrorText(result));
		}
	}
	else { result = ERROR_BAD_ARGUMENTS; }
	return result;
}
